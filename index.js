import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import FormData from 'form-data';
import {createRequire} from 'module';
import sqlite3 from 'sqlite3';
import cron from 'node-cron';
import {
    TELEGRAM_BOT_TOKEN,
    OPENAI_API_KEY,
    GETCOURSE_API_KEY,
    GETCOURSE_GROUP_ID,
    ADMIN_CHAT_ID,
    TELEGRAM_API_BASE,
    GETCOURSE_API_BASE,
    OPENAI_API_CHAT,
    OPENAI_API_WHISPER
} from './config/constants.js';
import {SYSTEM_PROMPT} from './config/systemPrompt.js';

const require = createRequire(import.meta.url);
const extractTextFromPdf = require('../recruti_bot/utils/extractTextFromPdf.cjs');

ffmpeg.setFfmpegPath(ffmpegPath);

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {polling: true});
const db = new sqlite3.Database('./users.db');
const chatHistories = {};
const pendingEmails = new Map();

db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, chat_id INTEGER UNIQUE);`);


function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function splitMessage(text, maxLength = 4000) {
    const parts = [];
    while (text.length > maxLength) {
        let part = text.slice(0, maxLength);
        const lastNewline = part.lastIndexOf('\n');
        if (lastNewline > 0) part = part.slice(0, lastNewline);
        parts.push(part.trim());
        text = text.slice(part.length).trim();
    }
    if (text.length > 0) parts.push(text.trim());
    return parts;
}

function isEmail(text) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

function checkAccessByEmail(email) {
    return new Promise((resolve) => {
        db.get('SELECT 1 FROM users WHERE email = ?', [email.toLowerCase()], (err, row) => {
            if (err) return resolve(false);
            resolve(!!row);
        });
    });
}

function isUserAuthorized(chatId) {
    return new Promise((resolve) => {
        db.get('SELECT 1 FROM users WHERE chat_id = ?', [chatId], (err, row) => {
            if (err) return resolve(false);
            resolve(!!row);
        });
    });
}


async function syncGetCourseUsers() {
    try {
        const exportResp = await fetch(`${GETCOURSE_API_BASE}/account/groups/${GETCOURSE_GROUP_ID}/users?key=${GETCOURSE_API_KEY}`);
        const exportData = await exportResp.json();
        const exportId = exportData?.info?.export_id;
        if (!exportId) return;

        let exportInfo = null;
        let ready = false;

        for (let i = 1; i <= 10; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const statusResp = await fetch(`${GETCOURSE_API_BASE}/account/exports/${exportId}?key=${GETCOURSE_API_KEY}`);
            exportInfo = await statusResp.json();
            if (exportInfo?.info?.items?.length) {
                ready = true;
                break;
            }
        }

        if (!ready) return;

        const items = exportInfo.info.items;
        const emailIndex = exportInfo.info.fields.indexOf('Email');
        if (emailIndex === -1) return;

        db.serialize(() => {
            const stmt = db.prepare('INSERT OR IGNORE INTO users (email) VALUES (?)');
            for (const row of items) {
                const email = row[emailIndex]?.trim().toLowerCase();
                if (email) stmt.run(email);
            }
            stmt.finalize();
        });
    } catch {
    }
}

syncGetCourseUsers();
cron.schedule('*/5 * * * *', syncGetCourseUsers);

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const isAuth = await isUserAuthorized(chatId);

    if (isAuth) {
        chatHistories[chatId] = [{role: 'system', content: SYSTEM_PROMPT}];
        return bot.sendMessage(chatId, `
        👋 Привет! Я — карьерный AI-консультант Техниума. 
        Помогаю оформить инженерное резюме, которое звучит уверенно и по делу.
        💬 Просто пришли текст, голос или PDF — и я всё сделаю.
        📖 Подробнее — команда /help
        `);
    } else {
        bot.sendMessage(chatId, '🛡 Пожалуйста, отправь свой Email для подтверждения доступа.');
        pendingEmails.set(chatId, true);
    }
});

bot.onText(/\/reset/, (msg) => {
    const chatId = msg.chat.id;
    chatHistories[chatId] = [{role: 'system', content: SYSTEM_PROMPT}];
    bot.sendMessage(chatId, 'История очищена 🧼\nМожешь начать заново!');
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, `🛠 Чем я могу помочь:

• Преобразую твой опыт в инженерное резюме
• Прочитаю PDF и предложу улучшения
• Приму голосовое и соберу резюме по диктовке
• Придумаю карьерную легенду и отвечу на HR-вопросы

📂 Поддерживаю форматы:
- Текст
- Голосовые сообщения
- PDF-файлы

💬 Просто пришли сообщение - я всё обработаю.

📎 Команды:
/help - что может бот
/reset - очистить историю переписки
/status - проверить доступ к боту
/logout - выйти из системы

📖 Подробнее о возможностях бота читай здесь:
https://telegra.ph/Kak-polzovatsya-karernym-AI-botom-ot-Tehniuma-06-17`);
});

bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    db.get('SELECT email FROM users WHERE chat_id = ?', [chatId], (err, row) => {
        if (row) {
            bot.sendMessage(chatId, `✅ У вас есть доступ.\n📧 Email: ${row.email}`);
        } else {
            bot.sendMessage(chatId, '❌ Вы не авторизованы. Введите /start для доступа.');
        }
    });
});

bot.onText(/\/logout/, (msg) => {
    const chatId = msg.chat.id;
    db.run('UPDATE users SET chat_id = NULL WHERE chat_id = ?', [chatId], () => {
        chatHistories[chatId] = [{role: 'system', content: SYSTEM_PROMPT}];
        bot.sendMessage(chatId, '🚪 Вы вышли. Введите /start для повторной авторизации.');
    });
});

bot.onText(/\/debug/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId !== parseInt(ADMIN_CHAT_ID)) return bot.sendMessage(chatId, '🚫 Команда недоступна.');
    db.get('SELECT COUNT(*) as total FROM users', (err1, row1) => {
        db.get('SELECT COUNT(*) as active FROM users WHERE chat_id IS NOT NULL', (err2, row2) => {
            bot.sendMessage(chatId, `📊 Всего пользователей: ${row1.total}\n👥 Активных: ${row2.active}`);
        });
    });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (msg.text?.startsWith('/')) return;

    if (pendingEmails.has(chatId)) {
        if (isEmail(text)) {
            const hasAccess = await checkAccessByEmail(text);
            if (hasAccess) {
                db.run('UPDATE users SET chat_id = ? WHERE LOWER(email) = LOWER(?)', [chatId, text]);
                pendingEmails.delete(chatId);
                chatHistories[chatId] = [{role: 'system', content: SYSTEM_PROMPT}];
                return bot.sendMessage(chatId, `✅ Доступ подтверждён!

👋 Я — карьерный AI-консультант Техниума.

📌 Вот чем могу помочь:
• Проверю и улучшу твоё резюме под нужный грейд
• Преобразую не-IT опыт в IT-кейсы
• Придумаю карьерную легенду и грамотно её оформлю
• Распознаю голосовое и соберу по нему резюме
• Прочитаю PDF и выдам улучшенную версию

💡 Просто пришли текст, голос или PDF. Список команд - /help

📖 Подробнее о возможностях бота читай здесь:
https://telegra.ph/Kak-polzovatsya-karernym-AI-botom-ot-Tehniuma-06-17`);
            } else {
                return bot.sendMessage(chatId, '❌ Email не найден. Доступ запрещён.');
            }
        } else {
            return bot.sendMessage(chatId, '❗️Введите корректный Email для продолжения.');
        }
    }

    const isAuth = await isUserAuthorized(chatId);
    if (!isAuth) return bot.sendMessage(chatId, '🛡 У вас нет доступа. Напишите /start и следуйте инструкциям.');

    if (!chatHistories[chatId]) chatHistories[chatId] = [{role: 'system', content: SYSTEM_PROMPT}];

    if (text) {
        chatHistories[chatId].push({role: 'user', content: text});
        await bot.sendChatAction(chatId, 'typing');
        return handleOpenAI(chatId);
    }

    if (msg.voice) {
        try {
            await bot.sendMessage(chatId, '🎙 Расшифровываю голос...');
            await bot.sendMessage(chatId, '📋 После расшифровки соберу резюме на основе твоего рассказа и оформлю его в инженерном формате.');
            const file = await bot.getFile(msg.voice.file_id);
            const url = `${TELEGRAM_API_BASE}/${file.file_path}`;
            const ogg = `voice-${chatId}.ogg`, mp3 = `voice-${chatId}.mp3`;
            const res = await fetch(url);
            fs.writeFileSync(ogg, Buffer.from(await res.arrayBuffer()));
            await new Promise((r, e) => ffmpeg(ogg).toFormat('mp3').on('end', r).on('error', e).save(mp3));
            const form = new FormData();
            form.append('file', fs.createReadStream(mp3));
            form.append('model', 'whisper-1');
            const whRes = await fetch(OPENAI_API_WHISPER, {
                method: 'POST',
                headers: {Authorization: `Bearer ${OPENAI_API_KEY}`},
                body: form
            });
            const {text} = await whRes.json();
            chatHistories[chatId].push({role: 'user', content: text});
            fs.unlinkSync(ogg);
            fs.unlinkSync(mp3);
            await bot.sendChatAction(chatId, 'typing');
            return handleOpenAI(chatId);
        } catch {
            return bot.sendMessage(chatId, '❌ Ошибка при обработке голоса');
        }
    }

    if (msg.document?.mime_type === 'application/pdf') {
        try {
            await bot.sendMessage(chatId, '📄 Читаю PDF...');
            await bot.sendMessage(chatId, '🔍 Сейчас проанализирую PDF и подготовлю улучшенную версию твоего резюме - с чёткой подачей, инженерными задачами и пояснениями. Можно будет использовать как основу для итогового файла.');
            const file = await bot.getFile(msg.document.file_id);
            const url = `${TELEGRAM_API_BASE}/${file.file_path}`;
            const pdf = `resume-${chatId}.pdf`;
            const res = await fetch(url);
            fs.writeFileSync(pdf, Buffer.from(await res.arrayBuffer()));
            const text = await extractTextFromPdf(pdf);
            fs.unlinkSync(pdf);
            if (!text || text.length < 20) throw new Error();
            chatHistories[chatId].push({role: 'user', content: `📄 Резюме:\n\n${text}`});
            await bot.sendChatAction(chatId, 'typing');
            return handleOpenAI(chatId);
        } catch {
            return bot.sendMessage(chatId, '❌ Не удалось распознать PDF');
        }
    }

});

async function handleOpenAI(chatId) {
    try {
        const res = await fetch(OPENAI_API_CHAT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: chatHistories[chatId]
            })
        });

        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content;
        if (!reply) return bot.sendMessage(chatId, 'Пустой ответ от AI');

        const cleanedReply = reply
            .replace(/^#{1,6}\s*/gm, '')
            .replace(/\*\*/g, '');

        chatHistories[chatId].push({role: 'assistant', content: reply});

        const sections = cleanedReply.split(/(?=^ *(?:#{2,3} |📁|📄|🎓|📐|🔧|📝|🔗|📌|📓|🛠|🧠|🔍|📍|🔥|🧩|📤|🚀|🏆|🧑|✏️|🎯))/gm);

        for (const sec of sections) {
            if (!sec.trim()) continue;

            const title = sec.trim().split('\n')[0]?.toLowerCase();
            const isPlainText = ['памятка', 'пояснения', 'hr-ответы'].some(keyword =>
                title.includes(keyword)
            );

            const safe = escapeHtml(sec);
            const chunks = splitMessage(safe);

            for (const chunk of chunks) {
                if (isPlainText) {
                    await bot.sendMessage(chatId, chunk);
                } else {
                    await bot.sendMessage(chatId, `<pre>${chunk}</pre>`, {parse_mode: 'HTML'});
                }
            }
        }
    } catch {
        bot.sendMessage(chatId, '❌ Ошибка при запросе к AI');
    }
}
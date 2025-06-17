import dotenv from 'dotenv';
dotenv.config();

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const GETCOURSE_API_KEY = process.env.GETCOURSE_API_KEY;
export const GETCOURSE_GROUP_ID = process.env.GETCOURSE_GROUP_ID;
export const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

export const TELEGRAM_API_BASE = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;
export const GETCOURSE_API_BASE = 'https://eduivashev.getcourse.ru/pl/api';
export const OPENAI_API_CHAT = 'https://api.openai.com/v1/chat/completions';
export const OPENAI_API_WHISPER = 'https://api.openai.com/v1/audio/transcriptions';
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const API_BASE_URL = 'https://airsongsapi.vercel.app';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set!');

const bot = new TelegramBot(token);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const update = req.body;

    if (update.message) {
      await handleMessage(update.message);
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const messageText = msg.text;

  if (!messageText) return;

  if (messageText === '/start') {
    return bot.sendMessage(chatId,
      '🎵 *Welcome to AirSongs Bot!* 🎵\n\n' +
      'Search for any song and I will help you:\n' +
      '• 🎧 Stream music directly\n' +
      '• 📥 Download MP3 files\n' +
      '• 📝 Get lyrics\n' +
      '• ℹ️ View song details\n\n' +
      'Just type the name of any song to get started\n\n' +
      '*Examples:*\n' +
      '• Arjan Vailly\n' +
      '• Shape of You\n' +
      '• Blinding Lights\n\n' +
      'Built with ❤️ by AirSongs',
      { parse_mode: 'Markdown' }
    );
  }

  if (messageText === '/help') {
    return bot.sendMessage(chatId,
      '🤖 *AirSongs Bot Commands:*\n\n' +
      '/start - Start the bot\n' +
      '/help - Show this help message\n\n' +
      '🔍 *How to use:*\n' +
      '1. Send me any song name\n' +
      '2. Choose from the search results\n' +
      '3. Stream, download, or get lyrics\n\n' +
      '💡 *Tips:*\n' +
      '• Be specific with song names for better results\n' +
      '• Include artist name for more accurate search\n\n' +
      '🎵 Enjoy your music',
      { parse_mode: 'Markdown' }
    );
  }

  if (messageText.startsWith('/')) return;

  try {
    await bot.sendChatAction(chatId, 'typing');

    const response = await axios.get(`${API_BASE_URL}/result/?query=${encodeURIComponent(messageText)}`);

    if (!Array.isArray(response.data) || response.data.length === 0) {
      return bot.sendMessage(chatId, '❌ No songs found. Try a different search term.');
    }

    const songs = response.data.slice(0, 5);
    await bot.sendMessage(chatId, `🔍 Found ${songs.length} results for "${messageText}":`);

    for (const song of songs) {
      const duration = `${Math.floor(song.duration / 60)}:${String(song.duration % 60).padStart(2, '0')}`;
      const songInfo =
        `🎵 *${song.song}*\n` +
        `👤 Artist: ${song.primary_artists}\n` +
        `💽 Album: ${song.album}\n` +
        `⏱️ Duration: ${duration}\n` +
        `🗓️ Year: ${song.year}\n` +
        `🌐 Language: ${song.language}`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: '🎧 Stream', callback_data: `stream_${song.id}` },
            { text: '📥 Download', callback_data: `download_${song.id}` }
          ],
          [
            { text: '📝 Lyrics', callback_data: `lyrics_${song.id}` },
            { text: 'ℹ️ Info', callback_data: `info_${song.id}` }
          ]
        ]
      };

      if (song.image) {
        await bot.sendPhoto(chatId, song.image, {
          caption: songInfo,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      } else {
        await bot.sendMessage(chatId, songInfo, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      }
    }
  } catch (error) {
    console.error('Search error:', error.message);
    await bot.sendMessage(chatId, '❌ Sorry, there was an error. Please try again.');
  }
}

async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  try {
    const underscoreIndex = data.indexOf('_');
    const action = data.substring(0, underscoreIndex);
    const songId = data.substring(underscoreIndex + 1);

    const songResponse = await axios.get(`${API_BASE_URL}/song/?query=${songId}`);

    let song;
    if (Array.isArray(songResponse.data) && songResponse.data.length > 0) {
      song = songResponse.data[0];
    } else {
      return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Song not found!' });
    }

    switch (action) {
      case 'stream':
        await bot.sendChatAction(chatId, 'upload_audio');
        if (song.media_url) {
          await bot.sendAudio(chatId, song.media_url, {
            title: song.song,
            performer: song.primary_artists,
            duration: parseInt(song.duration)
          });
          await bot.answerCallbackQuery(callbackQuery.id, { text: '🎧 Streaming...' });
        } else {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Stream not available!' });
        }
        break;

      case 'download':
        if (song.media_url) {
          await bot.sendMessage(chatId, `📥 *Download Link:*\n${song.media_url}\n\nClick the link to download the MP3 file.`, { parse_mode: 'Markdown' });
          await bot.answerCallbackQuery(callbackQuery.id, { text: '📥 Download link sent!' });
        } else {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Download not available!' });
        }
        break;

      case 'lyrics':
        await bot.sendChatAction(chatId, 'typing');
        try {
          const lyricsResponse = await axios.get(`${API_BASE_URL}/lyrics/?query=${songId}`);
          if (lyricsResponse.data.success && lyricsResponse.data.data && lyricsResponse.data.data.lyrics) {
            const lyrics = lyricsResponse.data.data.lyrics;
            const truncated = lyrics.length > 3800 ? lyrics.substring(0, 3800) + '\n...' : lyrics;
            await bot.sendMessage(chatId, `📝 *Lyrics for ${song.song}*\n\n${truncated}`, { parse_mode: 'Markdown' });
            await bot.answerCallbackQuery(callbackQuery.id, { text: '📝 Lyrics loaded!' });
          } else {
            await bot.sendMessage(chatId, '❌ Lyrics not available for this song.');
            await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ No lyrics found!' });
          }
        } catch {
          await bot.sendMessage(chatId, '❌ Error fetching lyrics.');
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Error fetching lyrics!' });
        }
        break;

      case 'info': {
        const duration = `${Math.floor(song.duration / 60)}:${String(song.duration % 60).padStart(2, '0')}`;
        const infoMessage =
          `ℹ️ *Song Information*\n\n` +
          `🎵 *Title:* ${song.song}\n` +
          `👤 *Artist:* ${song.primary_artists}\n` +
          `💽 *Album:* ${song.album}\n` +
          `⏱️ *Duration:* ${duration}\n` +
          `🗓️ *Year:* ${song.year}\n` +
          `🌐 *Language:* ${song.language}\n` +
          `▶️ *Play Count:* ${song.play_count ? parseInt(song.play_count).toLocaleString() : 'N/A'}\n` +
          `🏷️ *Label:* ${song.label || 'N/A'}`;

        await bot.sendMessage(chatId, infoMessage, { parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'ℹ️ Info displayed!' });
        break;
      }

      default:
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Unknown action!' });
    }
  } catch (error) {
    console.error('Callback error:', error.message);
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Error processing request!' });
  }
}

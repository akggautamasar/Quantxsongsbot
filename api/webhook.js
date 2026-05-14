const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const youtubeSr = require('youtube-sr').default;
const ytdl = require('@distube/ytdl-core');

const API_BASE_URL = 'https://airsongsapi.vercel.app';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set!');

const bot = new TelegramBot(token);

// In-memory song cache: songKey -> song object
// Key is a short index we generate to avoid long callback_data
const songCache = {};
let cacheCounter = 0;

// Separate cache for YouTube results
const ytCache = {};

function cacheSong(song) {
  cacheCounter++;
  const key = String(cacheCounter);
  songCache[key] = song;
  // Keep cache small — remove old entries after 500
  if (cacheCounter > 500) {
    delete songCache[String(cacheCounter - 500)];
  }
  return key;
}

function cacheYt(video) {
  cacheCounter++;
  const key = 'yt' + String(cacheCounter);
  ytCache[key] = video;
  return key;
}

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
      '• ℹ️ View song details\n' +
      '• 🎬 YouTube search with /yt\n\n' +
      'Just type the name of any song to get started\n\n' +
      '*Examples:*\n' +
      '• Arjan Vailly\n' +
      '• Shape of You\n' +
      '• /yt Blinding Lights\n\n' +
      'Built with ❤️ by AirSongs',
      { parse_mode: 'Markdown' }
    );
  }

  if (messageText === '/help') {
    return bot.sendMessage(chatId,
      '🤖 *AirSongs Bot Commands:*\n\n' +
      '/start - Start the bot\n' +
      '/help - Show this help message\n' +
      '/yt SongName - Search YouTube\n\n' +
      '🔍 *How to use:*\n' +
      '1. Send me any song name (uses AirSongs API)\n' +
      '2. Or use /yt to search YouTube\n' +
      '3. Choose from results and stream or download\n\n' +
      '💡 *Tips:*\n' +
      '• Be specific with song names for better results\n' +
      '• Include artist name for more accurate search\n\n' +
      '🎵 Enjoy your music',
      { parse_mode: 'Markdown' }
    );
  }

  // YouTube search command
  if (messageText.startsWith('/yt')) {
    const query = messageText.replace(/^\/yt\s*/i, '').trim();
    if (!query) {
      return bot.sendMessage(chatId, '❌ Please provide a song name.\n\nExample: /yt Shape of You');
    }
    return handleYoutubeSearch(chatId, query);
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
      // Cache the full song object and get a short key
      const cacheKey = cacheSong(song);

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
            { text: '🎧 Stream', callback_data: `stream_${cacheKey}` },
            { text: '📥 Download', callback_data: `download_${cacheKey}` }
          ],
          [
            { text: '📝 Lyrics', callback_data: `lyrics_${cacheKey}` },
            { text: 'ℹ️ Info', callback_data: `info_${cacheKey}` }
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

  // Route YouTube callbacks separately
  if (data.startsWith('ytdl_')) {
    return handleYtCallback(callbackQuery);
  }

  try {
    const underscoreIndex = data.indexOf('_');
    const action = data.substring(0, underscoreIndex);
    const cacheKey = data.substring(underscoreIndex + 1);

    // Get song from cache — no extra API call needed
    const song = songCache[cacheKey];

    if (!song) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Session expired. Search the song again.' });
      return;
    }

    switch (action) {
      case 'stream':
        await bot.sendChatAction(chatId, 'upload_audio');
        if (song.media_url) {
          try {
            // Download file as buffer so we can set a proper filename
            const audioResp = await axios.get(song.media_url, {
              responseType: 'arraybuffer',
              timeout: 25000
            });
            const buffer = Buffer.from(audioResp.data);
            const safeName = song.song.replace(/[^a-zA-Z0-9 _\-]/g, '').trim() || 'song';
            const fileName = `${safeName} - ${song.primary_artists}.m4a`;
            await bot.sendAudio(chatId, buffer,
              {
                title: song.song,
                performer: song.primary_artists,
                duration: parseInt(song.duration)
              },
              {
                filename: fileName,
                contentType: 'audio/mp4'
              }
            );
            await bot.answerCallbackQuery(callbackQuery.id, { text: '🎧 Streaming...' });
          } catch (err) {
            console.error('Audio download error:', err.message);
            // Fallback: send URL directly (filename will be hash, but at least it works)
            await bot.sendAudio(chatId, song.media_url, {
              title: song.song,
              performer: song.primary_artists,
              duration: parseInt(song.duration)
            });
            await bot.answerCallbackQuery(callbackQuery.id, { text: '🎧 Streaming...' });
          }
        } else {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Stream not available for this song!' });
        }
        break;

      case 'download':
        if (song.media_url) {
          await bot.sendMessage(chatId,
            `📥 *Download Link:*\n${song.media_url}\n\nClick the link to download the MP3 file.`,
            { parse_mode: 'Markdown' }
          );
          await bot.answerCallbackQuery(callbackQuery.id, { text: '📥 Download link sent!' });
        } else {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Download not available for this song!' });
        }
        break;

      case 'lyrics':
        await bot.sendChatAction(chatId, 'typing');
        try {
          const lyricsResponse = await axios.get(`${API_BASE_URL}/lyrics/?query=${song.id}`);
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

// ── YouTube Search ──────────────────────────────────────────────
async function handleYoutubeSearch(chatId, query) {
  try {
    await bot.sendChatAction(chatId, 'typing');
    await bot.sendMessage(chatId, `🎬 Searching YouTube for "${query}"...`);

    const results = await youtubeSr.search(query, { limit: 5, type: 'video' });

    if (!results || results.length === 0) {
      return bot.sendMessage(chatId, '❌ No YouTube results found. Try a different search term.');
    }

    for (const video of results) {
      const cacheKey = cacheYt({
        id: video.id,
        title: video.title,
        channel: video.channel?.name || 'Unknown',
        duration: video.duration,
        thumbnail: video.thumbnail?.url || ''
      });

      const dur = video.durationFormatted || '?';
      const info =
        `🎬 *${video.title}*\n` +
        `👤 Channel: ${video.channel?.name || 'Unknown'}\n` +
        `⏱️ Duration: ${dur}\n` +
        `🔗 youtube.com/watch?v=${video.id}`;

      const keyboard = {
        inline_keyboard: [[
          { text: '🎧 Download Audio', callback_data: `ytdl_${cacheKey}` }
        ]]
      };

      if (video.thumbnail?.url) {
        await bot.sendPhoto(chatId, video.thumbnail.url, {
          caption: info,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      } else {
        await bot.sendMessage(chatId, info, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      }
    }
  } catch (err) {
    console.error('YouTube search error:', err.message);
    await bot.sendMessage(chatId, '❌ YouTube search failed. Please try again.');
  }
}

// ── YouTube Download Callback ───────────────────────────────────
async function handleYtCallback(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const cacheKey = callbackQuery.data.replace('ytdl_', '');
  const video = ytCache[cacheKey];

  if (!video) {
    return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Session expired. Search again.' });
  }

  await bot.answerCallbackQuery(callbackQuery.id, { text: '⏳ Preparing audio...' });
  await bot.sendChatAction(chatId, 'upload_audio');
  await bot.sendMessage(chatId, `⏳ Downloading *${video.title}*...\nThis may take a moment.`, { parse_mode: 'Markdown' });

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;

    const info = await ytdl.getInfo(videoUrl);
    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highestaudio',
      filter: 'audioonly'
    });

    if (!format || !format.url) {
      return bot.sendMessage(chatId, '❌ Could not get audio URL for this video.');
    }

    const audioResp = await axios.get(format.url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const buffer = Buffer.from(audioResp.data);
    const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);

    if (buffer.length > 45 * 1024 * 1024) {
      return bot.sendMessage(chatId, `❌ File too large (${sizeMB}MB). Telegram limit is 50MB.\n\nTry a shorter video.`);
    }

    const safeName = video.title.replace(/[^a-zA-Z0-9 _\-]/g, '').trim() || 'audio';
    const fileName = `${safeName}.m4a`;

    await bot.sendAudio(chatId, buffer,
      {
        title: video.title,
        performer: video.channel,
        duration: Math.floor((video.duration || 0) / 1000)
      },
      {
        filename: fileName,
        contentType: format.mimeType?.split(';')[0] || 'audio/mp4'
      }
    );

  } catch (err) {
    console.error('YT download error:', err.message);
    await bot.sendMessage(chatId,
      '❌ Download failed. This can happen with:\n' +
      '• Age-restricted videos\n' +
      '• Very long videos (over 15 min)\n' +
      '• Region-blocked content\n\n' +
      'Try a different video.'
    );
  }
}

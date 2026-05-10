import { axios } from '../../utils/scrapper-deps.js';
import { USER_AGENT } from '../../utils/constants.js';

const MIRURO_BASE_URL = 'https://www.miruro.tv';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADLESS_TIMEOUT_MS = 20000;

const parseEpisodeNumber = (animeEpisodeId, epQuery) => {
  if (epQuery && Number(epQuery) > 0) {
    return Number(epQuery);
  }

  if (!animeEpisodeId) return 1;

  const queryMatch = animeEpisodeId.match(/[?#&]ep=(\d+)/i);
  if (queryMatch) return Number(queryMatch[1]);

  return 1;
};

const normalizeAnimeId = (animeEpisodeId) => {
  if (!animeEpisodeId) return null;

  return animeEpisodeId
    .split('#')[0]
    .split('?')[0]
    .replace(/^\/info\//, '')
    .replace(/^\/watch\//, '')
    .trim();
};

const normalizeCategory = (category) => {
  const c = String(category || 'sub').toLowerCase().trim();
  if (c === 'dub' || c === 'sub') return c;
  return 'sub';
};

const normalizeServer = (server) => {
  const s = String(server || 'telli').toLowerCase().trim();
  const validServers = ['telli', 'ally', 'bee', 'bun', 'nun', 'kiwi', 'dune'];
  if (validServers.includes(s)) return s;
  return 'telli';
};

const collectCandidateUrls = ($, scriptsText) => {
  const urls = new Set();
  const attrNames = ['data-embed', 'data-src', 'data-url', 'data-source', 'data-player', 'data-iframe', 'data-file'];

  attrNames.forEach((attr) => {
    `[${attr}]`;
    $(`[${attr}]`).each((_, el) => {
      const value = $(el).attr(attr);
      if (value && value.startsWith('http')) urls.add(value.trim());
    });
  });

  $('iframe, video, source').each((_, el) => {
    const value = $(el).attr('src');
    if (value && value.startsWith('http')) urls.add(value.trim());
  });

  if (scriptsText) {
    const matches = scriptsText.match(/https?:\/\/[^"'\s<>]+/g) || [];
    matches.forEach((url) => urls.add(url.trim()));
  }

  return [...urls];
};

const pickBestEmbedUrl = (candidates, serverName) => {
  if (!candidates || candidates.length === 0) return null;
  const serverKey = String(serverName || '').toLowerCase();

  const byServer = candidates.filter((url) => url.toLowerCase().includes(serverKey));
  const byEmbed = (list) => list.find((url) => /embed|player|source|stream/i.test(url));
  const byM3u8 = (list) => list.find((url) => url.toLowerCase().includes('.m3u8'));

  return (
    byM3u8(byServer) ||
    byEmbed(byServer) ||
    byM3u8(candidates) ||
    byEmbed(candidates) ||
    candidates[0]
  );
};

const extractM3u8WithPuppeteer = async (targetUrl, referer, serverName, category) => {
  if (process.env.MIRURO_USE_HEADLESS === 'false') return null;

  const puppeteerModule = await import('puppeteer');
  const puppeteer = puppeteerModule.default || puppeteerModule;
  let browser;
  let page;
  let m3u8Url = null;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    page = await browser.newPage();
    await page.setUserAgent(DEFAULT_UA);
    if (referer) {
      await page.setExtraHTTPHeaders({ Referer: referer });
    }

    const captureUrl = (url) => {
      if (url && url.includes('.m3u8')) {
        m3u8Url = url;
      }
    };

    page.on('request', (req) => captureUrl(req.url()));
    page.on('response', (res) => captureUrl(res.url()));

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: HEADLESS_TIMEOUT_MS });

    const initialM3u8 = m3u8Url;

    const selectionResult = await page.evaluate(
      async ({ server, categoryLabel }) => {
        const normalize = (value) => String(value || '').toLowerCase().trim();
        const targetServer = normalize(server);
        const targetCategory = normalize(categoryLabel);

        const getTriggers = () => Array.from(document.querySelectorAll('button[class*="_trigger_"]'));
        const getItems = () => Array.from(document.querySelectorAll('[class*="_item_"]'));

        const clickItem = (textMatch) => {
          const items = getItems();
          for (const node of items) {
            const text = normalize(node.textContent || '');
            if (text === textMatch) {
              const target = node.closest('button') || node;
              target.click();
              return true;
            }
          }
          return false;
        };

        let categoryTrigger = null;
        let serverTrigger = null;
        let currentCategory = null;
        let currentServer = null;

        for (const trigger of getTriggers()) {
          const text = normalize(trigger.textContent || '');
          if (text === 'sub' || text === 'dub') {
            categoryTrigger = trigger;
            currentCategory = text;
          } else if (text) {
            serverTrigger = trigger;
            currentServer = text;
          }
        }

        const needsCategoryChange = currentCategory && currentCategory !== targetCategory;
        const needsServerChange = currentServer && currentServer !== targetServer;
        const changeRequested = needsCategoryChange || needsServerChange;

        if (needsCategoryChange && categoryTrigger) {
          categoryTrigger.click();
          await new Promise((resolve) => setTimeout(resolve, 200));
          clickItem(targetCategory);
        }

        if (needsServerChange && serverTrigger) {
          serverTrigger.click();
          await new Promise((resolve) => setTimeout(resolve, 200));
          clickItem(targetServer);
        }

        return { changeRequested, currentCategory, currentServer };
      },
      { server: serverName, categoryLabel: category }
    );

    if (!selectionResult?.changeRequested && initialM3u8) {
      return initialM3u8;
    }

    m3u8Url = null;
    const endAt = Date.now() + 10000;
    while ((!m3u8Url || m3u8Url === initialM3u8) && Date.now() < endAt) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!m3u8Url || m3u8Url === initialM3u8) {
      await page.evaluate(
        async ({ server, categoryLabel }) => {
          const normalize = (value) => String(value || '').toLowerCase().trim();
          const targetServer = normalize(server);
          const targetCategory = normalize(categoryLabel);

          const getItems = () => Array.from(document.querySelectorAll('[class*="_item_"]'));
          const getTriggers = () => Array.from(document.querySelectorAll('button[class*="_trigger_"]'));

          const clickItem = (textMatch) => {
            for (const node of getItems()) {
              const text = normalize(node.textContent || '');
              if (text === textMatch) {
                const target = node.closest('button') || node;
                target.click();
                return true;
              }
            }
            return false;
          };

          const triggers = getTriggers();
          const categoryTrigger = triggers.find((t) => {
            const text = normalize(t.textContent || '');
            return text === 'sub' || text === 'dub';
          });
          const serverTrigger = triggers.find((t) => {
            const text = normalize(t.textContent || '');
            return text && text !== 'sub' && text !== 'dub';
          });

          const items = getItems().map((node) => normalize(node.textContent || ''));
          const otherCategory = items.find((text) => text && text !== targetCategory && (text === 'sub' || text === 'dub'));
          const otherServer = items.find((text) => text && text !== targetServer && text !== 'sub' && text !== 'dub');

          if (categoryTrigger && otherCategory) {
            categoryTrigger.click();
            await new Promise((resolve) => setTimeout(resolve, 200));
            clickItem(otherCategory);
            await new Promise((resolve) => setTimeout(resolve, 200));
            categoryTrigger.click();
            await new Promise((resolve) => setTimeout(resolve, 200));
            clickItem(targetCategory);
          }

          if (serverTrigger && otherServer) {
            serverTrigger.click();
            await new Promise((resolve) => setTimeout(resolve, 200));
            clickItem(otherServer);
            await new Promise((resolve) => setTimeout(resolve, 200));
            serverTrigger.click();
            await new Promise((resolve) => setTimeout(resolve, 200));
            clickItem(targetServer);
          }
        },
        { server: serverName, categoryLabel: category }
      );

      const retryEndAt = Date.now() + 10000;
      while ((!m3u8Url || m3u8Url === initialM3u8) && Date.now() < retryEndAt) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  } catch {
    return null;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {}
    }
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }

  return m3u8Url;
};

export const getMiruroEpisodeSources = async ({ animeEpisodeId, ep, server, category }) => {
  const animeId = normalizeAnimeId(animeEpisodeId);

  if (!animeId) {
    throw new Error('animeEpisodeId query parameter is required');
  }

  const episodeNumber = parseEpisodeNumber(animeEpisodeId, ep);
  const normalizedServer = normalizeServer(server);
  const normalizedCategory = normalizeCategory(category);

  const watchUrl = `${MIRURO_BASE_URL}/watch/${animeId}?ep=${episodeNumber}`;

  // Try to fetch the watch page to get video source
  try {
    const { load } = await import('cheerio');
    const { data: html } = await axios.get(watchUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: MIRURO_BASE_URL,
      },
      timeout: 15000,
    });

    const $ = load(html);

    // Look for video sources in the page
    const videoSrc = $('video source').attr('src') || $('video').attr('src') || null;
    const iframeSrc = $('iframe').attr('src') || null;

    // Look for any m3u8 or mp4 URLs in scripts
    const scripts = $('script:not([src])').map((_, el) => $(el).text()).get().join(' ');

    // Multiple patterns for m3u8 URLs
    const m3u8Patterns = [
      /(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/,
      /(https?:\/\/[^"'\s]+\.m3u8)/,
      /["'](https?:\/\/[^"'\s]*stream[^"'\s]*\.m3u8[^"'\s]*)["']/,
      /["'](https?:\/\/[^"'\s]*video[^"'\s]*\.m3u8[^"'\s]*)["']/,
      /["'](https?:\/\/[^"'\s]*embed[^"'\s]*\.m3u8[^"'\s]*)["']/,
    ];

    let m3u8Url = null;
    for (const pattern of m3u8Patterns) {
      const match = scripts.match(pattern);
      if (match) {
        m3u8Url = match[1] || match[0];
        break;
      }
    }

    // Also check for .file or .url properties in JSON data
    if (!m3u8Url) {
      const fileMatch = scripts.match(/["']file["']\s*:\s*["'](https?:\/\/[^"'\s]+)["']/);
      const urlMatch = scripts.match(/["']url["']\s*:\s*["'](https?:\/\/[^"'\s]+)["']/);
      const sourceMatch = scripts.match(/["']source["']\s*:\s*["'](https?:\/\/[^"'\s]+)["']/);
      m3u8Url = fileMatch?.[1] || urlMatch?.[1] || sourceMatch?.[1] || null;
      if (m3u8Url && !m3u8Url.includes('.m3u8')) {
        m3u8Url = null;
      }
    }

    // Check for embed URLs that might lead to m3u8
    const embedMatch = scripts.match(/["']embed["']\s*:\s*["'](https?:\/\/[^"'\s]+)["']/);
    const candidates = collectCandidateUrls($, scripts);
    const embedUrl = embedMatch?.[1] || iframeSrc || pickBestEmbedUrl(candidates, normalizedServer) || null;

    const source = m3u8Url || (videoSrc && videoSrc.includes('.m3u8') ? videoSrc : null);

    if (source) {
      return {
        animeId,
        episode: episodeNumber,
        sourcePage: watchUrl,
        sources: [
          {
            source,
            type: 'm3u8',
            quality: null,
            referer: MIRURO_BASE_URL,
            server: normalizedServer,
            category: normalizedCategory,
          },
        ],
        tracks: [],
        intro: null,
        outro: null,
        note: 'Direct m3u8 stream found',
      };
    }

    if (embedUrl) {
      const embedSource = await (async () => {
        try {
          const { data: embedHtml } = await axios.get(embedUrl, {
            headers: {
              'User-Agent': DEFAULT_UA,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              Referer: MIRURO_BASE_URL,
            },
            timeout: 15000,
            validateStatus: () => true,
          });

          const { load: loadEmbed } = await import('cheerio');
          const $embed = loadEmbed(embedHtml);
          const embedScripts = $embed('script:not([src])').map((_, el) => $embed(el).text()).get().join(' ');
          const embedCandidates = collectCandidateUrls($embed, embedScripts);
          return pickBestEmbedUrl(embedCandidates, normalizedServer);
        } catch {
          return null;
        }
      })();

      if (embedSource && embedSource.includes('.m3u8')) {
        return {
          animeId,
          episode: episodeNumber,
          sourcePage: watchUrl,
          sources: [
            {
              source: embedSource,
              type: 'm3u8',
              quality: null,
              referer: embedUrl,
              server: normalizedServer,
              category: normalizedCategory,
            },
          ],
          tracks: [],
          intro: null,
          outro: null,
          note: 'm3u8 extracted from embed URL',
        };
      }
    }
  } catch (error) {
    console.log('[getMiruroEpisodeSources] Fetch error:', error.message);
  }

  // Try to get embed page source
  try {
    // Construct potential embed URLs based on server
    const serverUrls = {
      'telli': `https://telli.2anime.xyz/embed/${animeId}/${episodeNumber}`,
      'ally': `https://ally.2anime.xyz/embed/${animeId}/${episodeNumber}`,
      'bee': `https://bee.2anime.xyz/embed/${animeId}/${episodeNumber}`,
      'bun': `https://bun.2anime.xyz/embed/${animeId}/${episodeNumber}`,
      'nun': `https://nun.2anime.xyz/embed/${animeId}/${episodeNumber}`,
      'kiwi': `https://kiwi.2anime.xyz/embed/${animeId}/${episodeNumber}`,
      'dune': `https://dune.2anime.xyz/embed/${animeId}/${episodeNumber}`,
    };

    const embedUrl = serverUrls[normalizedServer] || serverUrls['telli'];

    const { data: embedHtml } = await axios.get(embedUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: MIRURO_BASE_URL,
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    const { load } = await import('cheerio');
    const $embed = load(embedHtml);

    // Look for video in embed page
    const embedVideoSrc = $embed('video source').attr('src') || $embed('video').attr('src') || null;

    // Search scripts in embed page
    const embedScripts = $embed('script:not([src])').map((_, el) => $embed(el).text()).get().join(' ');

    // Look for m3u8 in embed scripts - include ultracloud.cc pattern
    const embedM3u8Patterns = [
      /(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i,
      /(https?:\/\/[^"'\s]+\.m3u8)/i,
      /["'](https?:\/\/[^"'\s]*\.m3u8[^"'\s]*)["']/i,
      /["'](https?:\/\/[^"'\s]*pl\.m3u8[^"'\s]*)["']/i,
      /["'](https?:\/\/[^"'\s]*index\.m3u8[^"'\s]*)["']/i,
      /file\s*:\s*["'](https?:\/\/[^"'\s]+)["']/i,
      /src\s*:\s*["'](https?:\/\/[^"'\s]+)["']/i,
      /url\s*:\s*["'](https?:\/\/[^"'\s]+)["']/i,
      /(https?:\/\/[^"'\s]*ultracloud[^"'\s]*\.m3u8[^"'\s]*)/i,
    ];

    let embedM3u8 = null;
    for (const pattern of embedM3u8Patterns) {
      const match = embedScripts.match(pattern);
      if (match) {
        embedM3u8 = match[1] || match[0];
        break;
      }
    }

    const embedSource = embedM3u8 || embedVideoSrc || null;

    if (embedSource) {
      const isM3u8 = embedSource.includes('.m3u8');

      return {
        animeId,
        episode: episodeNumber,
        sourcePage: watchUrl,
        sources: [
          {
            source: embedSource,
            type: isM3u8 ? 'm3u8' : 'mp4',
            quality: null,
            referer: embedUrl,
            server: normalizedServer,
            category: normalizedCategory,
          },
        ],
        tracks: [],
        intro: null,
        outro: null,
        note: isM3u8 ? 'm3u8 extracted from embed page' : 'Video source from embed page',
      };
    }
  } catch (embedError) {
    console.log('[getMiruroEpisodeSources] Embed fetch error:', embedError.message);
  }

  // Headless fallback to capture m3u8 from dynamic requests
  try {
    const serverUrls = {
      'telli': `https://telli.2anime.xyz/embed/${animeId}/${episodeNumber}`,
      'ally': `https://ally.2anime.xyz/embed/${animeId}/${episodeNumber}`,
      'bee': `https://bee.2anime.xyz/embed/${animeId}/${episodeNumber}`,
      'bun': `https://bun.2anime.xyz/embed/${animeId}/${episodeNumber}`,
      'nun': `https://nun.2anime.xyz/embed/${animeId}/${episodeNumber}`,
      'kiwi': `https://kiwi.2anime.xyz/embed/${animeId}/${episodeNumber}`,
      'dune': `https://dune.2anime.xyz/embed/${animeId}/${episodeNumber}`,
    };

    const embedTarget = serverUrls[normalizedServer] || serverUrls['telli'];
    const m3u8FromWatch = await extractM3u8WithPuppeteer(
      watchUrl,
      MIRURO_BASE_URL,
      normalizedServer,
      normalizedCategory
    );
    const m3u8FromEmbed = m3u8FromWatch
      ? null
      : await extractM3u8WithPuppeteer(embedTarget, MIRURO_BASE_URL, normalizedServer, normalizedCategory);
    const m3u8 = m3u8FromEmbed || m3u8FromWatch;

    if (m3u8) {
      return {
        animeId,
        episode: episodeNumber,
        sourcePage: watchUrl,
        sources: [
          {
            source: m3u8,
            type: 'm3u8',
            quality: null,
            referer: MIRURO_BASE_URL,
            server: normalizedServer,
            category: normalizedCategory,
          },
        ],
        tracks: [],
        intro: null,
        outro: null,
        note: 'm3u8 captured from headless browser requests',
      };
    }
  } catch (headlessError) {
    console.log('[getMiruroEpisodeSources] Headless fetch error:', headlessError.message);
  }

  // Final fallback: return the watch URL as iframe source
  return {
    animeId,
    episode: episodeNumber,
    sourcePage: watchUrl,
    sources: [
      {
        source: watchUrl,
        type: 'iframe',
        quality: null,
        referer: MIRURO_BASE_URL,
        server: normalizedServer,
        category: normalizedCategory,
      },
    ],
    tracks: [],
    intro: null,
    outro: null,
    note: 'Miruro.tv uses client-side video loading. Try using puppeteer or browser automation to extract actual m3u8 sources.',
  };
};

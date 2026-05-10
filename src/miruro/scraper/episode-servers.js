import { axios, load } from '../../utils/scrapper-deps.js';
import { USER_AGENT } from '../../utils/constants.js';

const MIRURO_BASE_URL = 'https://www.miruro.tv';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_SERVERS = ['kiwi', 'telli', 'ally', 'bee', 'dune', 'bun', 'nun'];

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

export const getMiruroEpisodeServers = async ({ animeEpisodeId, ep }) => {
  const animeId = normalizeAnimeId(animeEpisodeId);

  if (!animeId) {
    throw new Error('animeEpisodeId query parameter is required');
  }

  const episodeNumber = parseEpisodeNumber(animeEpisodeId, ep);
  const watchUrl = `${MIRURO_BASE_URL}/watch/${animeId}?ep=${episodeNumber}`;

  // Fetch the watch page to extract server list
  try {
    const { data: html } = await axios.get(watchUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: MIRURO_BASE_URL,
      },
      timeout: 15000,
    });

    const $ = load(html);

    // Extract title
    const title = $('h1, .title, [class*="title"]').first().text().trim() || 'Unknown';

    // Look for server buttons/selectors in the page
    const servers = [];

    // Common patterns for server buttons
    $('[class*="server"], [class*="source"], [data-server], [data-source]').each((_, el) => {
      const $el = $(el);
      const serverName = $el.text().trim() || $el.attr('data-server') || $el.attr('data-source') || null;
      const serverId = $el.attr('data-id') || $el.attr('data-server') || $el.attr('value') || null;
      const category = $el.attr('data-type') || $el.attr('data-category') || 'sub';

      if (serverName) {
        servers.push({
          serverName,
          serverId: serverId || `${animeId}:${episodeNumber}:${category}:${serverName.toLowerCase().replace(/\s+/g, '-')}`,
          category: category.toLowerCase().includes('dub') ? 'dub' : 'sub',
        });
      }
    });

    // If no servers found from buttons, try to find in scripts
    if (servers.length === 0) {
      const scripts = $('script:not([src])').map((_, el) => $(el).text()).get().join(' ');

      // Look for server data in JSON
      const serverMatches = scripts.match(/["']servers?["']\s*:\s*(\[.*?\])/s);
      if (serverMatches) {
        try {
          const serverData = JSON.parse(serverMatches[1]);
          serverData.forEach((s, idx) => {
            servers.push({
              serverName: s.name || `Server ${idx + 1}`,
              serverId: s.id || `${animeId}:${episodeNumber}:sub:server-${idx + 1}`,
              category: s.type?.toLowerCase().includes('dub') ? 'dub' : 'sub',
            });
          });
        } catch {}
      }
    }

    // Always include known Miruro server names to ensure full list
    const defaultServers = [
      ...DEFAULT_SERVERS.map((name) => ({
        serverName: name,
        serverId: `${animeId}:${episodeNumber}:sub:${name}`,
        category: 'sub',
      })),
      ...DEFAULT_SERVERS.map((name) => ({
        serverName: name,
        serverId: `${animeId}:${episodeNumber}:dub:${name}`,
        category: 'dub',
      })),
    ];

    const normalized = [...servers, ...defaultServers];

    // Group servers by category and de-duplicate by category + name
    const seen = new Set();
    const subServers = [];
    const dubServers = [];

    for (const server of normalized) {
      const key = `${server.category}:${server.serverName}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      if (server.category === 'dub') {
        dubServers.push(server);
      } else {
        subServers.push(server);
      }
    }

    return {
      source: watchUrl,
      animeId,
      title,
      episode: episodeNumber,
      categories: {
        sub: subServers,
        dub: dubServers,
      },
      note: 'Server list extracted from watch page with Miruro defaults ensured.',
    };
  } catch (error) {
    console.log('[getMiruroEpisodeServers] Fetch error:', error.message);

    // Fallback
    return {
      source: watchUrl,
      animeId,
      title: 'Unknown',
      episode: episodeNumber,
      categories: {
        sub: [{ serverName: 'Default', serverId: `${animeId}:${episodeNumber}:sub:default`, category: 'sub' }],
        dub: [],
      },
      note: `Failed to fetch watch page: ${error.message}`,
    };
  }
};

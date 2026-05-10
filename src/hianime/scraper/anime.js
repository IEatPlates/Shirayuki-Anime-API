import { fetchHiAnimePage } from './_shared.js';

const parseNumber = (value) => {
  const match = value?.match(/\d+/);
  return match ? Number(match[0]) : null;
};

const getWatchId = (href) => {
  if (!href) return null;
  const cleanHref = href.split('#')[0].split('?')[0].trim();
  const watchPrefix = '/watch/';
  if (cleanHref.startsWith(watchPrefix)) {
    return cleanHref.slice(watchPrefix.length) || null;
  }
  return cleanHref.replace(/^\//, '') || null;
};

export const getHiAnimeAnimeDetails = async (animeId) => {
  const { url, $ } = await fetchHiAnimePage(`/${animeId}`);

  const detail = $('.anisc-detail').first();
  if (!detail.length) {
    throw new Error('Anime not found or page structure changed');
  }

  const title = detail.find('.film-name').first().text().trim() || null;
  const jname = detail.find('.film-name').first().attr('data-jname')?.trim() || null;
  const altTitle = detail.find('.alias-name').first().text().trim() || null;
  const description =
    detail.find('.film-description .text').first().text().trim() ||
    detail.find('.film-description').first().text().trim() ||
    null;
  const poster =
    detail.find('.anisc-poster img').attr('data-src')?.trim() ||
    detail.find('.anisc-poster img').attr('src')?.trim() ||
    null;

  const stats = detail.find('.film-stats');
  const rating = detail.find('.film-score, .score').first().text().trim() || null;
  const sub = parseNumber(stats.find('.tick-item.tick-sub').text().trim() || '');
  const dub = parseNumber(stats.find('.tick-item.tick-dub').text().trim() || '');
  const format =
    stats.find('.item, span, a')
      .map((_, el) => $(el).text().trim())
      .get()
      .find((text) => /[A-Za-z]/.test(text) && !/sub|dub/i.test(text)) ||
    null;

  const details = {};
  const genres = [];

  // .anisc-info is a sibling of .anisc-detail, not inside it
  const info = $('.anisc-info').first();

  // Handle genres - look for .item-list with Genres heading
  info.find('.item-list').each((_, el) => {
    const $el = $(el);
    const head = $el.find('.item-head').text().trim();
    if (head === 'Genres:') {
      $el.find('a[href*="/genre/"]').each((__, a) => {
        const g = $(a).text().trim();
        if (g) genres.push(g);
      });
    }
  });

  // Handle other details - look for .item-title elements
  info.find('.item-title').each((_, el) => {
    const $el = $(el);
    const key = $el.find('.item-head').text().trim().replace(':', '');
    const value = $el.find('.name').text().trim();

    if (key === 'Genres') {
      $el.find('a[href*="/genre/"]').each((__, a) => {
        const g = $(a).text().trim();
        if (g) genres.push(g);
      });
    } else if (key && value) {
      const normalizedKey = key.toLowerCase().replace(/\s+/g, '');
      details[normalizedKey] = value;
    }
  });

  const malLink = detail.find('a[href*="myanimelist.net"]').attr('href') || null;
  const alLink = detail.find('a[href*="anilist.co"]').attr('href') || null;

  const relations = [];
  $('.block_area').each((_, block) => {
    const $block = $(block);
    const heading = $block.find('.block_area-header .cat-heading').text().trim();
    if (!/related/i.test(heading)) return;

    $block.find('.flw-item').each((__, el) => {
      const $el = $(el);
      const href = $el.find('a.film-poster-ahref').attr('href')?.trim() || null;
      relations.push({
        id: getWatchId(href),
        title: $el.find('.film-name a').text().trim() || null,
        jname: $el.find('.film-name a').attr('data-jname')?.trim() || null,
        poster:
          $el.find('img.film-poster-img').attr('data-src')?.trim() ||
          $el.find('img.film-poster-img').attr('src')?.trim() ||
          null,
        relation: heading || null,
        type: $el.find('.fd-infor a').first().text().trim() || null,
        episodes: {
          sub: parseNumber($el.find('.tick-item.tick-sub').text().trim() || ''),
          dub: parseNumber($el.find('.tick-item.tick-dub').text().trim() || ''),
        },
      });
    });
  });

  return {
    id: animeId,
    source: url,
    title,
    jname,
    altTitle,
    description,
    poster,
    rating,
    format,
    episodes: {
      sub,
      dub,
    },
    genres,
    details: {
      country: details.country || null,
      premiered: details.premiered || null,
      aired: details.aired || null,
      broadcast: details.broadcast || null,
      totalEpisodes: details.episodes || null,
      duration: details.duration || null,
      status: details.status || null,
      malScore: details.mal || null,
      studios: details.studios || null,
      producers: details.producers || null,
    },
    externalLinks: {
      mal: malLink,
      anilist: alLink,
    },
    relations,
  };
};

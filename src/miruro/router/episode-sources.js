import { Hono } from 'hono';
import { miruroEpisodeSourcesController } from '../controllers/episode-sources.js';

const miruroEpisodeSourcesRouter = new Hono();

miruroEpisodeSourcesRouter.get('/sources', miruroEpisodeSourcesController);

export default miruroEpisodeSourcesRouter;

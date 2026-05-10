import { Hono } from 'hono';
import { miruroEpisodeServersController } from '../controllers/episode-servers.js';

const miruroEpisodeServersRouter = new Hono();

miruroEpisodeServersRouter.get('/servers', miruroEpisodeServersController);

export default miruroEpisodeServersRouter;

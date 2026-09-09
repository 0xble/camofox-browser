// Local checkpoint endpoint kept separate from the upstream Camofox package.
// It deliberately provides no VNC or interactive-browser capability.
import { persistStorageState } from '../../lib/persistence.js';

export default function register(app, ctx) {
  const profileDir = process.env.CAMOFOX_PROFILE_DIR || ctx.config.profileDir;

  app.get('/sessions/:userId/storage_state', ctx.auth(), async (req, res) => {
    const userId = String(req.params.userId);
    const session = ctx.sessions.get(userId);
    if (!session) {
      return res.status(404).json({ error: `No active session for userId="${userId}"` });
    }

    try {
      // Read at request time: plugin loading order is not a persistence contract.
      const storageStateOptions = ctx.persistenceStorageStateOptions;
      const indexedDB = storageStateOptions?.indexedDB === true;
      const storageState = await session.context.storageState(storageStateOptions);
      const checkpoint = await persistStorageState({
        profileDir,
        userId,
        storageState,
        indexedDB,
        logger: { warn: (message, fields) => ctx.log('warn', message, fields) },
      });

      // persistStorageState intentionally reports filesystem failures as data.
      // Do not return storage material until its durable checkpoint is confirmed.
      if (!checkpoint.persisted) {
        throw new Error('storage state checkpoint failed');
      }

      ctx.log('info', 'storage_state exported', {
        reqId: req.reqId,
        userId,
        cookies: storageState.cookies?.length || 0,
        origins: storageState.origins?.length || 0,
        indexedDB,
      });
      return res.json(storageState);
    } catch (err) {
      ctx.log('error', 'storage_state export failed', {
        reqId: req.reqId,
        userId,
        error: err?.message || String(err),
      });
      return res.status(500).json({ error: 'storage state checkpoint failed' });
    }
  });

  ctx.log('info', 'local storage checkpoint plugin: registered GET /sessions/:userId/storage_state');
}

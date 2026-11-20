import { DocsWriteError } from './google.js';

export function createDocsDocumentLock(pool) {
  return async (documentId, execute) => {
    const key = `rl67:cta-writer:${documentId}`;
    const client = await pool.connect();
    let locked = false;
    let releaseError;
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key]);
      locked = rows[0]?.locked === true;
      if (!locked) throw new DocsWriteError('DOC_DOCUMENT_BUSY');
      return await execute();
    } finally {
      if (locked) {
        try {
          const { rows } = await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', [key]);
          if (!rows[0]?.released) throw new DocsWriteError('DOC_DOCUMENT_LOCK_LOST');
        } catch (error) {
          releaseError = error;
        }
      }
      client.release(releaseError);
      if (releaseError) throw releaseError;
    }
  };
}

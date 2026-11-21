/* Transport and reconciliation for the separate test PWA. */
(function (root) {
  'use strict';
  const protocol = 'shtab-hq-offline-v1';
  const frameOrigin = /^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/;

  function pendingChanges(local, accepted) {
    const key = entry => JSON.stringify([entry.kind, entry.id, entry.field, entry.from, entry.to, entry.editedAt]);
    const known = new Set(accepted.map(key));
    return local.filter(entry => !known.has(key(entry)));
  }

  function createTransport(host, endpoint) {
    let popup, peer, peerOrigin, nonce, pending;
    function clear(error) {
      if (!pending) return;
      host.clearTimeout(pending.timer);
      const { reject } = pending;
      pending = null;
      reject(error);
    }
    function receive(event) {
      const message = event.data;
      if (!popup || !event.source || !frameOrigin.test(event.origin) ||
          message?.protocol !== protocol || message.nonce !== nonce) return;
      try { if (event.source.top !== popup) return; } catch (_) { return; }
      if (message.type === 'ready' && !peer) {
        peer = event.source;
        peerOrigin = event.origin;
        return;
      }
      if (event.source !== peer || event.origin !== peerOrigin || !pending ||
          message.type !== 'response' || message.id !== pending.id) return;
      if (!message.ok) return clear(new Error('SYNC_SERVER'));
      host.clearTimeout(pending.timer);
      const { resolve } = pending;
      pending = null;
      resolve(message.reply);
    }
    host.addEventListener('message', receive);
    return {
      connect() {
        clear(new Error('SYNC_RECONNECTED'));
        popup?.close();
        peer = null;
        nonce = host.crypto.randomUUID();
        const url = new URL(endpoint);
        url.searchParams.set('offlineHQ', nonce);
        popup = host.open(url.href, '_blank', 'popup');
        return Boolean(popup);
      },
      ready() { return Boolean(peer && popup && !popup.closed); },
      exchange(request) {
        if (!this.ready() || pending) return Promise.reject(new Error('SYNC_UNAVAILABLE'));
        const id = host.crypto.randomUUID();
        return new Promise((resolve, reject) => {
          pending = { id, resolve, reject, timer: host.setTimeout(() => clear(new Error('SYNC_TIMEOUT')), 45000) };
          try { peer.postMessage({ protocol, nonce, type: 'exchange', id, request }, peerOrigin); }
          catch (error) { clear(error); }
        });
      },
    };
  }

  async function exchangeJournal({ transport, snapshotId, journal, validate, merge }) {
    const updates = [];
    const results = [];
    // Include a read even when there are no outgoing edits.
    for (let start = 0; start < Math.max(1, journal.length); start += 100) {
      const changes = journal.slice(start, start + 100);
      const reply = await transport.exchange({ snapshotId, changes, commit: changes.length > 0 });
      if (reply?.snapshotId !== snapshotId || !Array.isArray(reply.results) || !Array.isArray(reply.updates)) {
        throw new Error('SYNC_BAD_REPLY');
      }
      validate(reply.updates);
      updates.splice(0, updates.length, ...reply.updates);
      results.push(...reply.results);
    }
    return { ...merge(journal, updates), results };
  }

  const api = { createTransport, exchangeJournal, pendingChanges };
  if (typeof module !== 'undefined') module.exports = api;
  else root.HQOfflineTransport = api;
})(typeof window === 'undefined' ? globalThis : window);

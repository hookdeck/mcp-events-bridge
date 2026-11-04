// Preloaded (node --import) into a child process to prove it makes no network calls: outbound sockets, DNS lookups
// and fetch each write a NETWORK line to stderr and throw.
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';

const blocked = (what) => {
  fs.writeSync(2, `NETWORK ${what}\n`);
  throw new Error(`network blocked: ${what}`);
};

net.Socket.prototype.connect = function connect(...args) {
  const [target] = args;
  blocked(`socket ${typeof target === 'object' && target ? `${target.host ?? target.path}:${target.port ?? ''}` : String(target)}`);
};
dns.lookup = (host) => blocked(`dns ${host}`);
dns.promises.lookup = async (host) => blocked(`dns ${host}`);
globalThis.fetch = async (input) => blocked(`fetch ${String(input)}`);

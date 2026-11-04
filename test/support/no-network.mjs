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
// lookup (getaddrinfo, what sockets use) and the resolve* family (c-ares), on dns, dns.promises and their Resolvers.
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const name of Object.keys(target).concat(Object.getOwnPropertyNames(target))) {
    if (name === 'lookup' || name === 'lookupService' || name.startsWith('resolve') || name === 'reverse') {
      target[name] = (host) => blocked(`dns ${name} ${host}`);
    }
  }
}
globalThis.fetch = async (input) => blocked(`fetch ${String(input)}`);

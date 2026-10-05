import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { CallbackUrlError, type CallbackTransport, type PostResult } from '../core/callback.js';

/*
 * CallbackTransport for a long-lived Node host, following the MCP Events
 * SSRF rules: non-public addresses blocked, the address checked at connect
 * time (so DNS rebinding can't swap it), and redirects never followed
 * (node:http doesn't follow them).
 */

// IANA special-purpose ranges that are not globally reachable.
const blockedV4 = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(network, prefix, 'ipv4');

const globalUnicastV6 = new net.BlockList();
globalUnicastV6.addSubnet('2000::', 3, 'ipv6');

const blockedV6 = new net.BlockList();
for (const [network, prefix] of [
  ['2001::', 23], // IETF protocol assignments (includes Teredo)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 can embed private IPv4 addresses
] as const) blockedV6.addSubnet(network, prefix, 'ipv6');

/** True when the address is globally routable (not loopback, private, link-local, documentation, and so on). */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    return globalUnicastV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  }
  return false;
}

const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');

class BlockedAddressError extends Error {
  code = 'EADDRBLOCKED';
}

/**
 * A dns.lookup replacement used for the outbound connection itself: the socket
 * connects to the address validated here, while TLS still uses the original
 * hostname for SNI and certificate checks.
 */
function safeLookup(allowNonPublic: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const list = addresses as dns.LookupAddress[];
      if (!allowNonPublic && (list.length === 0 || list.some((a) => !isPublicAddress(a.address)))) {
        return callback(new BlockedAddressError(`Blocked non-public address for ${hostname}`), '', 0);
      }
      if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface NodeCallbackTransportOptions {
  /** Tests only: skip the non-public address checks so a local server can stand in for a callback. */
  allowNonPublic?: boolean;
}

export function createNodeCallbackTransport({ allowNonPublic = false }: NodeCallbackTransportOptions = {}): CallbackTransport {
  return {
    async assertPublicHost(url) {
      if (allowNonPublic) return;
      const host = hostOf(url);
      const addresses = net.isIP(host) ? [host] : (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
      if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
        throw new CallbackUrlError('delivery.url resolves to a non-public address', 'callback_address_not_allowed');
      }
    },

    post(url, body, headers, { timeoutMs }) {
      return new Promise<PostResult>((resolve, reject) => {
        const host = hostOf(url);
        if (!allowNonPublic && net.isIP(host) && !isPublicAddress(host)) {
          return reject(new BlockedAddressError(`Blocked non-public address ${host}`));
        }
        const transport = url.protocol === 'https:' ? https : http;
        const request = transport.request(url, {
          method: 'POST',
          headers: { 'content-length': Buffer.byteLength(body), ...headers },
          lookup: safeLookup(allowNonPublic),
        });
        const timer = setTimeout(() => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeoutMs);
        request.on('response', (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
          });
          response.on('end', () => {
            clearTimeout(timer);
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
          response.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        request.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        request.end(body);
      });
    },
  };
}

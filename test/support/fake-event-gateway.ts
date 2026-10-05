/*
 * A fake Event Gateway API, enough for the store and setup tests: connection
 * upsert by name (creating sources and destinations by name), listing, and
 * deletes. Enforces the resource name pattern and description limit.
 */

interface Resource {
  id: string;
  name: string;
  type?: string;
  description?: string | null;
  config?: Record<string, unknown>;
  url?: string;
}

interface ConnectionResource {
  id: string;
  name: string;
  description?: string | null;
  sourceId: string;
  destinationId: string;
  rules: unknown[];
}

const NAME = /^[A-Za-z0-9_-]+$/;

export class FakeEventGateway {
  readonly sources = new Map<string, Resource>();
  readonly destinations = new Map<string, Resource>();
  readonly connections = new Map<string, ConnectionResource>();
  private counter = 0;

  private nextId(prefix: string) {
    return `${prefix}_${(++this.counter).toString().padStart(6, '0')}`;
  }

  private byName<T extends { name: string }>(map: Map<string, T>, name: string) {
    return [...map.values()].find((r) => r.name === name);
  }

  private view(c: ConnectionResource) {
    return {
      id: c.id,
      name: c.name,
      description: c.description ?? null,
      source: this.sources.get(c.sourceId),
      destination: this.destinations.get(c.destinationId),
      rules: c.rules,
    };
  }

  readonly fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/[0-9-]+/, '');
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

    if (method === 'PUT' && path === '/connections') {
      const body = JSON.parse(String(init?.body)) as {
        name: string;
        description?: string;
        source: { name: string; type?: string };
        destination: { name: string; type?: string; description?: string; config?: Record<string, unknown> };
        rules?: unknown[];
      };
      const names = [body.name, body.source.name, body.destination.name];
      const errors = names.filter((n) => !NAME.test(n)).map((n) => `name with value ${n} fails to match the required pattern`);
      for (const d of [body.description, body.destination.description]) if (d && d.length > 500) errors.push('description too long');
      if (errors.length) return json(422, { data: errors });

      let source = this.byName(this.sources, body.source.name);
      if (!source) {
        const id = this.nextId('src');
        source = { id, name: body.source.name, type: body.source.type, url: `https://hkdk.events/${id}` };
        this.sources.set(id, source);
      }
      let destination = this.byName(this.destinations, body.destination.name);
      if (!destination) {
        destination = { id: this.nextId('des'), name: body.destination.name };
        this.destinations.set(destination.id, destination);
      }
      Object.assign(destination, { type: body.destination.type, description: body.destination.description, config: body.destination.config });
      let connection = this.byName(this.connections, body.name);
      if (!connection) {
        connection = { id: this.nextId('web'), name: body.name, sourceId: source.id, destinationId: destination.id, rules: [] };
        this.connections.set(connection.id, connection);
      }
      Object.assign(connection, { description: body.description, rules: body.rules ?? [] });
      return json(200, this.view(connection));
    }

    if (method === 'GET' && path === '/connections') {
      return json(200, { models: [...this.connections.values()].map((c) => this.view(c)), pagination: {} });
    }

    const match = /^\/(connections|destinations|sources)\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && match) {
      const map = { connections: this.connections, destinations: this.destinations, sources: this.sources }[match[1] as 'connections'];
      return (map as Map<string, unknown>).delete(match[2]!) ? json(200, { id: match[2] }) : json(404, { message: 'not found' });
    }

    return json(404, { message: `fake: no route for ${method} ${path}` });
  }) as typeof fetch;
}

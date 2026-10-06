/** An in-memory GitHub hooks API (repository and organization webhooks), for registration tests. */
export class FakeGithub {
  /** Hooks by hooks path, e.g. /repos/o/r/hooks. */
  readonly hooks = new Map<string, Array<{ id: number; events: string[]; config: { url: string; secret: string } }>>();
  readonly calls: string[] = [];
  private nextId = 1;

  readonly fetch = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}`);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const match = /^(.*\/hooks)(?:\/(\d+))?$/.exec(url.pathname);
    if (!match) return new Response('{"message":"Not Found"}', { status: 404 });
    const [, path, id] = match as unknown as [string, string, string | undefined];
    const list = this.hooks.get(path) ?? [];
    this.hooks.set(path, list);
    if (method === 'GET' && !id) return Response.json(list);
    if (method === 'POST' && !id) {
      const hook = { id: this.nextId++, events: body.events, config: body.config };
      list.push(hook);
      return Response.json(hook, { status: 201 });
    }
    const hook = list.find((h) => h.id === Number(id));
    if (!hook) return new Response('{"message":"Not Found"}', { status: 404 });
    if (method === 'PATCH') {
      Object.assign(hook, { events: body.events, config: body.config });
      return Response.json(hook);
    }
    if (method === 'DELETE') {
      list.splice(list.indexOf(hook), 1);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }) as unknown as typeof globalThis.fetch;
}

export function pageMetadata(request: Request, response: Response): Response {
  if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')) return response
  const url = new URL(request.url)
  if (url.origin === 'https://joinallworld.com' && url.pathname === '/' && url.search === '') return response
  const headers = new Headers(response.headers)
  headers.set('X-Robots-Tag', 'noindex, nofollow')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

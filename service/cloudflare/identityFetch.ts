/** Workers rejects redirect:'error'. Keep the shared identity exchange's no-follow contract. */
export const cloudflareIdentityFetch: typeof fetch = async (input, options) => {
  const response = await fetch(input, { ...options, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) throw new Error('The identity exchange must not redirect.')
  return response
}

// The public feedback board for this App, kept on Goalmatic Feedback Studio. Every address the App
// uses for it is here and nowhere else. The generated public share fragment belongs with the
// board link. Account credentials and member data never belong here; nothing is added on opening.
//
// An address is filled in only after it has been opened and checked on the real board
// (docs/FEEDBACK-BOARD.md records that). Until then it stays null and the noticeboard says the
// board is not up yet instead of offering a link that may not work.

export interface FeedbackBoardConfig {
  /** The board's public page, where anyone can read, vote and post. Null until the board exists and the address is verified. */
  boardUrl: string | null
  /**
   * An address Feedback Studio itself supports for showing the board inside another page. Null
   * when no such address has been verified, or when the board refuses to be framed: the App then
   * opens the board in a new tab. Its host must also be listed in .goalmatic/app.json.
   */
  embedUrl: string | null
  /** The board's own page for a new idea, when it has one apart from `boardUrl`. */
  ideaUrl: string | null
  /** The board's own page for a new problem report, when it has one apart from `boardUrl`. */
  problemUrl: string | null
  /** Whether someone with no Feedback Studio account can post, as seen on the real board. Null: not checked yet. */
  guestPosting: boolean | null
  /** The day the addresses above were last opened and checked, as YYYY-MM-DD. */
  verifiedOn: string | null
}

/** Board and sharing policy verified in Feedback Studio; visitor form review is recorded separately. */
export const feedbackBoard: FeedbackBoardConfig = {
  boardUrl: 'https://feedback-studio.apps.goalmatic.io/b/allworld#zbHa8lqU0p8rDY1LdOEbYWrh6tHfkhqudJEygMwst6o',
  embedUrl: null,
  ideaUrl: null,
  problemUrl: null,
  guestPosting: true,
  verifiedOn: '2026-10-02',
}

/** The only hosts a board address may name. */
export const feedbackHosts = ['feedback-studio.apps.goalmatic.io'] as const

/**
 * A board address the App is willing to open: https, one of `feedbackHosts`, the default port, and
 * no user name or password. Anything else is treated as no address at all.
 */
export function safeBoardUrl(value: string | null | undefined): string | null {
  if (!value) return null
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  if (!(feedbackHosts as readonly string[]).includes(url.hostname)) return null
  return url.href
}

export interface FeedbackBoard {
  board: string
  /** Null: open the board in a new tab. */
  embed: string | null
  idea: string
  problem: string
  host: string
  guestPosting: boolean | null
}

/** The board as the App may use it, or null while there is no verified, safe address. */
export function resolveFeedbackBoard(config: FeedbackBoardConfig = feedbackBoard): FeedbackBoard | null {
  const board = safeBoardUrl(config.boardUrl)
  if (!board) return null
  return {
    board,
    embed: safeBoardUrl(config.embedUrl),
    idea: safeBoardUrl(config.ideaUrl) ?? board,
    problem: safeBoardUrl(config.problemUrl) ?? board,
    host: new URL(board).hostname,
    guestPosting: config.guestPosting,
  }
}

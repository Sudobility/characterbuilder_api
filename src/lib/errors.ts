/** Thrown by services; app.onError turns it into the error envelope with this HTTP status. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly headers?: Record<string, string>
  ) {
    super(message);
  }
}

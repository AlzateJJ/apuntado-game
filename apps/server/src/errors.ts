export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const sessionError = () =>
  new AppError(401, 'SESSION_INVALID', 'Tu sesión terminó. Vuelve a entrar.');

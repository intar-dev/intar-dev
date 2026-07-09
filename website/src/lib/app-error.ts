export interface AppErrorResponseBody {
  error: string;
  code?: string;
}

interface AppErrorInput {
  status: number;
  code: string;
  message: string;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(input: AppErrorInput) {
    super(input.message);
    this.name = "AppError";
    this.status = input.status;
    this.code = input.code;
  }
}

export function appError(
  status: number,
  code: string,
  message: string,
): AppError {
  return new AppError({ status, code, message });
}

export function toErrorResponse(
  error: unknown,
  fallbackMessage: string,
  fallbackStatus = 500,
): {
  status: number;
  body: AppErrorResponseBody;
} {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
      },
    };
  }

  console.error(
    JSON.stringify({
      message: fallbackMessage,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  return {
    status: fallbackStatus,
    body: {
      error: fallbackMessage,
    },
  };
}

// Internal errors; the HTTP adapter must add a fresh request_id and the API envelope.
export class ApiFault extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "ApiFault";
    this.code = code;
    this.status = status;
  }
}

export function fail(code: string, status: number): never {
  throw new ApiFault(code, status);
}

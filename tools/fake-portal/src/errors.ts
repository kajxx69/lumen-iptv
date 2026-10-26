export type FakePortalErrorCode = 'FFMPEG_NOT_FOUND' | 'FFMPEG_FAILED' | 'ASSET_INVALID' | 'TS_INVALID';

export class FakePortalError extends Error {
  readonly code: FakePortalErrorCode;

  constructor(code: FakePortalErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FakePortalError';
    this.code = code;
  }
}

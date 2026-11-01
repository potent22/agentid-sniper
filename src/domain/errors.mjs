// This error is proof from the local gateway that no external send was invoked.
// Network/API errors must never be promoted to this type.
export class NotSubmittedError extends Error {
  constructor(message = 'Stopping: command was not submitted') {
    super(message); this.name = 'NotSubmittedError'; this.code = 'NOT_SUBMITTED';
  }
}

/** Stop this worker without finalizing; reconcile server state before resuming. */
export class TaskExecutionInterrupted extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TaskExecutionInterrupted';
  }
}

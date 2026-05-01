export type { AiContext } from './aiContextBuilder'

export interface JobID {
  docId: string;
  blkId: string;
}

export interface AiListener<T = string> {
  onComplete: (jobId: JobID, response: T) => void;
  onError: (jobId: JobID, error: string) => void;
}


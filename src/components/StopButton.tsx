// How far a running replay has got. One copy, in App, drives every Stop button.
export type Progress = { at: number; of: number; stopping?: boolean };

export function StopButton({ progress, onStop, className }: { progress: Progress; onStop: () => void; className: string }) {
  return (
    <button type="button" onClick={onStop} disabled={progress.stopping} className={className}>
      {progress.stopping ? "Stopping..." : `Stop (${progress.at} of ${progress.of})`}
    </button>
  );
}

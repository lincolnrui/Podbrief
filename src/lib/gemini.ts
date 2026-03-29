export async function summarizeVideo(videoId: string, title?: string, description?: string) {
  let transcriptText = "";
  let durationSeconds = 0;
  let segments: { text: string; offset: number }[] = [];
  try {
    const res = await fetch(`/api/youtube/transcript?videoId=${videoId}`);
    if (res.ok) {
      const data = await res.json();
      transcriptText = data.text;
      durationSeconds = data.durationSeconds || 0;
      segments = data.segments || [];
    }
  } catch (err) {
    console.warn("Could not fetch transcript for video", videoId, err);
  }

  // Skip videos with no transcript — if the same episode is published in
  // multiple languages, we only want the version that has captions.
  if (!transcriptText) {
    throw new Error("NO_TRANSCRIPT");
  }

  const response = await fetch('/api/summarize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      videoId,
      title,
      description,
      transcriptText,
      durationSeconds
    })
  });

  const data = await response.json();

  if (!response.ok) {
    if (data.error === "VIDEO_TOO_SHORT") {
      throw new Error("VIDEO_TOO_SHORT");
    }
    throw new Error(data.error || "Failed to summarize video");
  }

  return { ...data, segments };
}

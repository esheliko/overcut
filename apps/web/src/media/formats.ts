/**
 * The formats the Media panel advertises as importable (the chips on the empty drop zone). One list, so it is the only line to touch when a
 * new demuxer or decoder lands (docs/features/media-bin.md "Formats"). Keep it to what really imports: a chip is a promise.
 * Today: video MP4/MOV/WebM, M4A, MP3 and WAV audio, JPG/PNG stills (MP3/WAV demux landed in UX r15 lane C).
 */
export const IMPORT_FORMATS: readonly string[] = ["MP4", "MOV", "WebM", "M4A", "MP3", "WAV", "JPG", "PNG"];

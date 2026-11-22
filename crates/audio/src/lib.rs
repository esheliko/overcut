//! # app-audio
//!
//! **Owns**: the mixer and audio graph, resampling, gain/fade/pan, ducking, loudness (LUFS), EQ/dynamics/denoise DSP, beat detection, the audio clock
//! that drives playback.
//!
//! **Rules**: the audio callback is allocation-free and lock-free; audio is the master clock for playback; DSP has golden-signal tests.
//!
//! Status: M0 skeleton, empty. First content arrives with M1 (waveform/playback clock) and M3 (mixer).

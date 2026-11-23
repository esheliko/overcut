//! # app-audio
//!
//! **Owns**: the mixer and audio graph, resampling, gain/fade/pan, ducking, loudness (LUFS), EQ/dynamics/denoise DSP, beat detection, the audio clock
//! that drives playback.
//!
//! **Rules**: the audio callback is allocation-free and lock-free; audio is the master clock for playback; DSP has golden-signal tests.
//!
//! Status: waveform peaks (`peaks`, M1-013). Playback clock arrives with M1, the mixer with M3.

pub mod peaks;

//! Ripple, gap close, roll, slip and slide (TL-04, `docs/features/timeline-ops.md`).
//!
//! Each is one `Op` that expands into a list of primitive `SetClip` / `Delete` steps applied by `apply_all`, so it is atomic, every
//! step is checked by the same rules as a hand-written edit (no overlap, source limits, locked tracks, integer ticks), and its inverse
//! is the combined inverse of the steps. Nothing is ever clamped or rounded: a edit that cannot fit is refused and changes nothing.

use crate::apply::{add, apply_all, find_clip, find_track, scaled, sub, OpError};
use crate::op::{Edge, Inverse, Op};
use app_model::{Clip, ClipId, Project, Time, TrackId};

pub(crate) fn apply_compound(p: &mut Project, op: Op) -> Result<Inverse, OpError> {
    let ops = match op {
        Op::RippleTrim {
            clip,
            edge,
            delta,
            all_tracks,
        } => ripple_trim(p, clip, edge, delta, all_tracks)?,
        Op::RippleDelete { clip, all_tracks } => ripple_delete(p, clip, all_tracks)?,
        Op::CloseGap {
            track,
            at,
            all_tracks,
        } => close_gap(p, track, at, all_tracks)?,
        Op::Roll { left, right, to } => roll(p, left, right, to)?,
        Op::Slip { clip, delta } => slip(p, clip, delta)?,
        Op::Slide { clip, delta } => slide(p, clip, delta)?,
        _ => unreachable!("only the compound ops are routed here"),
    };
    // Report the step's own error, not "batch step 3 failed".
    apply_all(p, &ops).map_err(|e| match e {
        OpError::Batch { cause, .. } => *cause,
        other => other,
    })
}

fn set(c: &Clip, start: Time, source_in: Time, duration: Time) -> Op {
    Op::SetClip {
        clip: c.id,
        start,
        source_in,
        duration,
    }
}

fn clip_ref(p: &Project, id: ClipId) -> Result<(usize, usize, Clip), OpError> {
    let loc = find_clip(p, id).ok_or(OpError::UnknownClip(id))?;
    let c = p.sequences[loc.seq].tracks[loc.track].clips[loc.clip].clone();
    Ok((loc.seq, loc.track, c))
}

/// `SetClip` steps that move every clip starting at or after `from` by `shift` ticks: on the track `own`, plus (with `all_tracks`) on
/// every other unlocked track of the sequence. Clips that start before `from` stay, even when they run past it. Ordered so that no
/// step lands on a neighbour that has not moved yet: earliest first when moving earlier, latest first when moving later.
fn shift_after(
    p: &Project,
    seq: usize,
    own: usize,
    from: Time,
    shift: Time,
    all_tracks: bool,
) -> Result<Vec<Op>, OpError> {
    let mut ops = Vec::new();
    if shift == Time::ZERO {
        return Ok(ops);
    }
    for (ti, t) in p.sequences[seq].tracks.iter().enumerate() {
        if ti != own && (!all_tracks || t.locked) {
            continue;
        }
        let mut track_ops = Vec::new();
        for c in t.clips.iter().filter(|c| c.start >= from) {
            track_ops.push(set(c, add(c.start, shift)?, c.source_in, c.duration));
        }
        if shift > Time::ZERO {
            track_ops.reverse();
        }
        ops.extend(track_ops);
    }
    Ok(ops)
}

fn neg(t: Time) -> Result<Time, OpError> {
    sub(Time::ZERO, t)
}

fn ripple_trim(
    p: &Project,
    clip: ClipId,
    edge: Edge,
    delta: Time,
    all_tracks: bool,
) -> Result<Vec<Op>, OpError> {
    let (seq, track, c) = clip_ref(p, clip)?;
    let old_end = c.end().ok_or(OpError::OutOfRange)?;
    // `shift`: how far later (positive) everything after the clip moves = the change in the clip's length.
    let (trimmed, shift) = match edge {
        Edge::Out => (
            set(&c, c.start, c.source_in, add(c.duration, delta)?),
            delta,
        ),
        Edge::In => (
            set(
                &c,
                c.start,
                add(c.source_in, scaled(delta, c.speed)?)?,
                sub(c.duration, delta)?,
            ),
            neg(delta)?,
        ),
    };
    let moves = shift_after(p, seq, track, old_end, shift, all_tracks)?;
    // Growing: make room first. Shrinking: trim first, then close up.
    Ok(if shift > Time::ZERO {
        [moves, vec![trimmed]].concat()
    } else {
        [vec![trimmed], moves].concat()
    })
}

fn ripple_delete(p: &Project, clip: ClipId, all_tracks: bool) -> Result<Vec<Op>, OpError> {
    let (seq, track, c) = clip_ref(p, clip)?;
    let end = c.end().ok_or(OpError::OutOfRange)?;
    let mut ops = vec![Op::Delete { clip }];
    ops.extend(shift_after(
        p,
        seq,
        track,
        end,
        neg(c.duration)?,
        all_tracks,
    )?);
    Ok(ops)
}

fn close_gap(p: &Project, track: TrackId, at: Time, all_tracks: bool) -> Result<Vec<Op>, OpError> {
    let (seq, ti) = find_track(p, track).ok_or(OpError::UnknownTrack(track))?;
    let t = &p.sequences[seq].tracks[ti];
    // The gap runs from the end of the last clip that ends at or before `at` (or from 0) to the first clip that starts after it.
    let mut gap_start = Time::ZERO;
    for c in &t.clips {
        let end = c.end().ok_or(OpError::OutOfRange)?;
        if c.start <= at && at < end {
            return Err(OpError::NotInGap);
        }
        if end <= at {
            gap_start = end;
        }
    }
    let next = t
        .clips
        .iter()
        .find(|c| c.start > at)
        .ok_or(OpError::NotInGap)?;
    let len = sub(next.start, gap_start)?;
    // `at` is in the gap and `next` starts after it, so the gap is never empty; a locked track is refused by its own steps.
    shift_after(p, seq, ti, next.start, neg(len)?, all_tracks)
}

fn roll(p: &Project, left: ClipId, right: ClipId, to: Time) -> Result<Vec<Op>, OpError> {
    let (lseq, lt, l) = clip_ref(p, left)?;
    let (rseq, rt, r) = clip_ref(p, right)?;
    let cut = l.end().ok_or(OpError::OutOfRange)?;
    if (lseq, lt) != (rseq, rt) || left == right || cut != r.start {
        return Err(OpError::NotAdjacent);
    }
    let new_left = set(&l, l.start, l.source_in, sub(to, l.start)?);
    let r_end = r.end().ok_or(OpError::OutOfRange)?;
    let new_right = set(
        &r,
        to,
        add(r.source_in, scaled(sub(to, r.start)?, r.speed)?)?,
        sub(r_end, to)?,
    );
    // The cut moving later: free the room on the right first; earlier: free the room on the left first.
    Ok(if to > cut {
        vec![new_right, new_left]
    } else {
        vec![new_left, new_right]
    })
}

fn slip(p: &Project, clip: ClipId, delta: Time) -> Result<Vec<Op>, OpError> {
    let (_, _, c) = clip_ref(p, clip)?;
    Ok(vec![set(&c, c.start, add(c.source_in, delta)?, c.duration)])
}

fn slide(p: &Project, clip: ClipId, delta: Time) -> Result<Vec<Op>, OpError> {
    let loc = find_clip(p, clip).ok_or(OpError::UnknownClip(clip))?;
    let clips = &p.sequences[loc.seq].tracks[loc.track].clips;
    let c = &clips[loc.clip];
    let end = c.end().ok_or(OpError::OutOfRange)?;
    let prev = loc.clip.checked_sub(1).map(|i| &clips[i]);
    let next = clips.get(loc.clip + 1);

    let moved = set(c, add(c.start, delta)?, c.source_in, c.duration);
    // The previous clip's out edge follows the clip's start; the next clip's in edge follows its end.
    let prev_op = match prev {
        Some(pc) if pc.end() == Some(c.start) => {
            Some(set(pc, pc.start, pc.source_in, add(pc.duration, delta)?))
        }
        _ => None,
    };
    let next_op = match next {
        Some(nc) if nc.start == end => Some(set(
            nc,
            add(nc.start, delta)?,
            add(nc.source_in, scaled(delta, nc.speed)?)?,
            sub(nc.duration, delta)?,
        )),
        _ => None,
    };
    // Moving later: the next clip steps aside first, the previous one grows last. Moving earlier: the mirror image.
    let mut ops = Vec::new();
    if delta > Time::ZERO {
        ops.extend(next_op);
        ops.push(moved);
        ops.extend(prev_op);
    } else {
        ops.extend(prev_op);
        ops.push(moved);
        ops.extend(next_op);
    }
    Ok(ops)
}

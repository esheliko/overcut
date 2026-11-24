//! Spike S9 (M2-001): native checksum and the per-parameter evaluation cost (`cargo run --release -p app-model --example s9_native`).
use app_model::{anim::golden_checksum, Animated, Easing, Keyframe, Time};
use std::time::Instant;

fn main() {
    println!("native checksum(1M) = {}", golden_checksum(1_000_000));
    for (name, easing) in [("linear", Easing::Linear), ("bezier", Easing::EASE)] {
        let mut a = Animated::constant(0.0);
        for i in 0..8 {
            let t = Time::from_ticks(i * 7_056_000);
            a.set_key(Keyframe {
                t,
                v: i as f64,
                easing,
            })
            .unwrap();
        }
        let n = 10_000_000_i64;
        let start = Instant::now();
        let mut acc = 0.0;
        for i in 0..n {
            acc += a.eval(Time::from_ticks((i * 4_999) % 49_392_000));
        }
        let ns = start.elapsed().as_nanos() as f64 / n as f64;
        println!("{name}: {ns:.1} ns per eval (8 keys, sum {acc:.1})");
    }
}

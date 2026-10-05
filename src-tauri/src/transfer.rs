//! Single source of truth for transfer progress (port of src/downloader/transfer.ts).
//!
//! The downloader reports what happens to each file; this turns it into one
//! snapshot the UI shows as is. Rules that keep the numbers honest:
//!  - A file is "settled" once it is saved, skipped, rejected, failed or cancelled;
//!    settled files count as processed, so the bar can reach 100% when the queue is done.
//!  - Percent is by size only when nearly every file has a known size, otherwise by
//!    file count (`basis` says which). It never shows 100% while a file is still running.
//!  - Speed is the real network rate over the last few seconds (retried bytes count);
//!    the ETA appears only once it is trustworthy.

use std::collections::HashMap;
use std::time::Instant;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Completed,
    Skipped,
    Rejected,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub total: usize,
    pub settled: usize,
    pub completed: usize,
    pub skipped: usize,
    pub rejected: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub retrying: usize,
    pub bytes: u64,
    pub total_bytes: u64,
    pub unknown_size: usize,
    pub percent: f64,
    pub basis: &'static str,
    pub speed: f64,
    pub eta_seconds: Option<u64>,
    pub elapsed_ms: u64,
    pub active: Vec<String>,
}

struct FileState {
    name: String,
    expected: u64,
    partial: u64,
    attempts: u32,
    active: bool,
    settled: Option<Kind>,
}

const SPEED_WINDOW_MS: u64 = 4000;
const MIN_KNOWN_SHARE: f64 = 0.8;

pub struct TransferTracker {
    files: HashMap<String, FileState>,
    started: Instant,
    samples: Vec<(u64, u64)>,
    transferred: u64,
    active_order: Vec<String>,
}

impl TransferTracker {
    pub fn new(files: impl IntoIterator<Item = (String, String, Option<u64>)>) -> Self {
        Self::at(files, Instant::now())
    }

    fn at(files: impl IntoIterator<Item = (String, String, Option<u64>)>, started: Instant) -> Self {
        let files = files
            .into_iter()
            .map(|(url, name, size)| (url, FileState { name, expected: size.unwrap_or(0), partial: 0, attempts: 0, active: false, settled: None }))
            .collect();
        Self { files, started, samples: Vec::new(), transferred: 0, active_order: Vec::new() }
    }

    fn ms(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.started).as_millis() as u64
    }

    /// A download attempt (the first or a retry) begins. Partial progress of a failed attempt is discarded.
    pub fn attempt(&mut self, url: &str) {
        let Some(file) = self.files.get_mut(url) else { return };
        if file.settled.is_some() {
            return;
        }
        file.attempts += 1;
        file.partial = 0;
        file.active = true;
        self.active_order.retain(|u| u != url);
        self.active_order.insert(0, url.to_string());
    }

    /// Total bytes received so far for this attempt.
    pub fn progress(&mut self, url: &str, bytes: u64, now: Instant) {
        let Some(file) = self.files.get_mut(url) else { return };
        if file.settled.is_some() || bytes <= file.partial {
            return;
        }
        self.transferred += bytes - file.partial;
        file.partial = bytes;
        let at = self.ms(now);
        self.samples.push((at, self.transferred));
        while self.samples.len() > 1 && at.saturating_sub(self.samples[0].0) > SPEED_WINDOW_MS {
            self.samples.remove(0);
        }
    }

    pub fn settle(&mut self, url: &str, kind: Kind) {
        let Some(file) = self.files.get_mut(url) else { return };
        if file.settled.is_some() {
            return;
        }
        file.settled = Some(kind);
        file.active = false;
        self.active_order.retain(|u| u != url);
    }

    fn speed(&mut self, now_ms: u64) -> f64 {
        // Drop old samples even when nothing arrived, so a stalled transfer shows 0, not its last rate.
        while !self.samples.is_empty() && now_ms.saturating_sub(self.samples[0].0) > SPEED_WINDOW_MS {
            self.samples.remove(0);
        }
        if self.samples.len() < 2 {
            return 0.0;
        }
        let (first_at, first_bytes) = self.samples[0];
        let (_, last_bytes) = self.samples[self.samples.len() - 1];
        let seconds = now_ms.saturating_sub(first_at) as f64 / 1000.0;
        if seconds >= 0.5 {
            last_bytes.saturating_sub(first_bytes) as f64 / seconds
        } else {
            0.0
        }
    }

    pub fn snapshot(&mut self, now: Instant) -> Snapshot {
        let now_ms = self.ms(now);
        let (mut completed, mut skipped, mut rejected, mut failed, mut cancelled) = (0, 0, 0, 0, 0);
        let (mut settled, mut total_bytes, mut known_files, mut settled_bytes, mut in_flight, mut retrying) = (0usize, 0u64, 0usize, 0u64, 0u64, 0usize);
        for file in self.files.values() {
            total_bytes += file.expected;
            if file.expected > 0 {
                known_files += 1;
            }
            if let Some(kind) = file.settled {
                settled += 1;
                settled_bytes += file.expected;
                match kind {
                    Kind::Completed => completed += 1,
                    Kind::Skipped => skipped += 1,
                    Kind::Rejected => rejected += 1,
                    Kind::Failed => failed += 1,
                    Kind::Cancelled => cancelled += 1,
                }
            } else if file.active {
                if file.expected > 0 {
                    in_flight += file.partial.min(file.expected);
                }
                if file.attempts > 1 {
                    retrying += 1;
                }
            }
        }
        let total = self.files.len();
        let by_bytes = total > 0 && total_bytes > 0 && known_files as f64 / total as f64 >= MIN_KNOWN_SHARE;
        let done = total > 0 && settled == total;
        let mut percent = 0.0;
        if total > 0 {
            percent = if by_bytes { (settled_bytes + in_flight) as f64 / total_bytes as f64 * 100.0 } else { settled as f64 / total as f64 * 100.0 };
            percent = if done { 100.0 } else { percent.min(99.9) };
        }
        let speed = self.speed(now_ms);
        let remaining = total_bytes.saturating_sub(settled_bytes + in_flight);
        let eta_seconds = if !done && by_bytes && speed > 2048.0 && now_ms > 3000 { Some((remaining as f64 / speed).round() as u64) } else { None };
        Snapshot {
            total,
            settled,
            completed,
            skipped,
            rejected,
            failed,
            cancelled,
            retrying,
            bytes: settled_bytes + in_flight,
            total_bytes,
            unknown_size: total - known_files,
            percent,
            basis: if by_bytes { "bytes" } else { "files" },
            speed,
            eta_seconds,
            elapsed_ms: now_ms,
            active: self.active_order.iter().take(3).map(|u| self.files.get(u).map(|f| f.name.clone()).unwrap_or_default()).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn tracker(sizes: &[Option<u64>]) -> (TransferTracker, Instant) {
        let start = Instant::now();
        let files = sizes.iter().enumerate().map(|(i, s)| (format!("u{i}"), format!("f{i}.pdf"), *s)).collect::<Vec<_>>();
        (TransferTracker::at(files, start), start)
    }

    #[test]
    fn handled_files_let_the_bar_finish() {
        let (mut t, start) = tracker(&[Some(100), Some(100), Some(100)]);
        t.settle("u0", Kind::Completed);
        t.settle("u1", Kind::Skipped);
        assert!(t.snapshot(start).percent < 100.0);
        t.settle("u2", Kind::Failed);
        let s = t.snapshot(start);
        assert_eq!((s.percent, s.settled, s.completed, s.skipped, s.failed), (100.0, 3, 1, 1, 1));
    }

    #[test]
    fn never_shows_100_while_a_file_is_in_flight() {
        let (mut t, start) = tracker(&[Some(100), Some(100)]);
        t.settle("u0", Kind::Completed);
        t.attempt("u1");
        t.progress("u1", 100, start + Duration::from_millis(100));
        assert!(t.snapshot(start + Duration::from_millis(200)).percent <= 99.9);
    }

    #[test]
    fn counts_files_when_sizes_are_missing() {
        let (mut t, start) = tracker(&[Some(1000), None, None, None]);
        t.settle("u1", Kind::Completed);
        let s = t.snapshot(start);
        assert_eq!((s.basis, s.unknown_size, s.percent), ("files", 3, 25.0));
    }

    #[test]
    fn a_retry_discards_partial_bytes_but_still_counts_the_wire_speed() {
        let (mut t, start) = tracker(&[Some(1000)]);
        t.attempt("u0");
        t.progress("u0", 400, start + Duration::from_millis(500));
        t.progress("u0", 800, start + Duration::from_secs(1));
        t.attempt("u0");
        let s = t.snapshot(start + Duration::from_secs(2));
        assert_eq!((s.retrying, s.bytes), (1, 0));
        assert!(s.speed > 0.0);
    }

    #[test]
    fn stalled_transfers_show_zero_speed_and_no_eta() {
        let (mut t, start) = tracker(&[Some(1_000_000), Some(1_000_000)]);
        t.attempt("u0");
        t.progress("u0", 10_000, start + Duration::from_millis(500));
        t.progress("u0", 500_000, start + Duration::from_millis(3500));
        assert!(t.snapshot(start + Duration::from_millis(3600)).eta_seconds.is_some());
        let later = t.snapshot(start + Duration::from_secs(20));
        assert_eq!((later.speed, later.eta_seconds), (0.0, None));
    }
}

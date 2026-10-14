//! The cancel token of one AI job: `ai_cancel(job)` sets it, and the request in flight (or the backoff sleep between
//! retries) stops at once.

use std::future::{poll_fn, Future};
use std::pin::pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::Poll;

use tokio::sync::Notify;

use super::AiError;

#[derive(Clone, Default, Debug)]
pub struct CancelToken(Arc<Inner>);

#[derive(Default, Debug)]
struct Inner {
    flag: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    pub fn cancelled_already() -> Self {
        let token = Self::default();
        token.cancel();
        token
    }

    pub fn cancel(&self) {
        self.0.flag.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.flag.load(Ordering::SeqCst)
    }

    /// Resolves once the token is cancelled.
    pub async fn cancelled(&self) {
        loop {
            let mut notified = pin!(self.0.notify.notified());
            // Registered before the flag is read, so a cancel in between is not missed.
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }

    /// Run `work` until it finishes or the token is cancelled (`AiError::Cancelled`; `work` is dropped, which aborts
    /// an HTTP request in flight).
    pub async fn run<T>(&self, work: impl Future<Output = Result<T, AiError>>) -> Result<T, AiError> {
        if self.is_cancelled() {
            return Err(AiError::Cancelled);
        }
        let mut cancelled = pin!(self.cancelled());
        let mut work = pin!(work);
        poll_fn(|cx| {
            if cancelled.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err(AiError::Cancelled));
            }
            work.as_mut().poll(cx)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pre_start_repeated_cancel_and_webview_ownership() {
        let ops = Operations::default();
        ops.cancel("a", "request").unwrap();
        ops.cancel("a", "request").unwrap();
        assert!(matches!(ops.begin("a", Some("request")), Err(e) if e == CANCELLED));
        let mut other = ops.begin("b", Some("request")).unwrap();
        assert_eq!(other.run(async { Ok(42) }).await.unwrap(), 42);
        other.complete(|| Ok(())).unwrap();
        ops.cancel("b", "request").unwrap();
        assert!(ops.begin("b", Some("request")).is_err());
    }

    #[tokio::test]
    async fn active_cancel_beats_ready_result_and_prevents_commit() {
        let ops = Operations::default();
        let mut op = ops.begin("a", Some("one")).unwrap();
        assert!(ops.begin("a", Some("one")).is_err());
        ops.cancel("a", "one").unwrap();
        assert_eq!(op.run(async { Ok(42) }).await.unwrap_err(), CANCELLED);
        assert_eq!(op.complete::<()>(|| panic!("must not commit")).unwrap_err(), CANCELLED);
    }

    #[test]
    fn history_is_bounded_expires_and_never_evicts_active_transfers() {
        let ops = Operations::default();
        let _active = ops.begin("a", Some("active")).unwrap();
        for n in 0..300 { ops.cancel("a", &n.to_string()).unwrap(); }
        let mut entries = ops.0.lock().unwrap();
        assert_eq!(entries.len(), HISTORY_LIMIT + 1);
        prune(&mut entries, Instant::now() + HISTORY_TTL);
        assert_eq!(entries.len(), 1);
        drop(entries);
        assert!(ops.begin("a", Some("active")).is_err());
        assert!(ops.begin("a", Some("299")).is_ok());
    }

    #[test]
    fn optional_and_invalid_request_ids() {
        let ops = Operations::default();
        assert!(ops.begin("a", None).is_ok());
        assert!(ops.begin("a", Some("")).is_err());
        assert!(ops.cancel("a", &"x".repeat(129)).is_err());
    }

    #[test]
    fn a_new_cancel_after_history_expiry_is_not_lost() {
        let ops = Operations::default();
        ops.0.lock().unwrap().insert(("a".into(), "old".into()),
            Entry::Terminal { cancelled: false, at: Instant::now() - HISTORY_TTL });
        ops.cancel("a", "old").unwrap();
        assert!(matches!(ops.begin("a", Some("old")), Err(e) if e == CANCELLED));
    }
}

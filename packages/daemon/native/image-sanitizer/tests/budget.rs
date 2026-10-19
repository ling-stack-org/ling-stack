#[path = "../src/budget.rs"]
mod budget;
#[global_allocator]
static ALLOCATOR: budget::Budgeted = budget::Budgeted;
#[test]
fn allocation_budget_is_enforced_in_subprocess() {
    if std::env::var_os("LING_SANITIZER_TEST_ALLOCATION").is_some() {
        let layout = std::alloc::Layout::from_size_align(budget::MAX_HEAP_BYTES + 1, 8).unwrap();
        // Call the implementation explicitly: an unused std::alloc::alloc can be
        // elided in optimized builds, which would bypass the intended test.
        let _ = unsafe { std::alloc::GlobalAlloc::alloc(&ALLOCATOR, layout) };
        panic!("allocation must terminate first");
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "allocation_budget_is_enforced_in_subprocess"])
        .env("LING_SANITIZER_TEST_ALLOCATION", "1")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
    assert!(output.stderr.is_empty());
}

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

// Bounds requested live heap allocations in this process, not kernel RSS or stack memory.
pub const MAX_HEAP_BYTES: usize = 512 * 1024 * 1024;
static LIVE: AtomicUsize = AtomicUsize::new(0);
pub struct Budgeted;

fn reserve(bytes: usize) {
    if LIVE
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |live| {
            live.checked_add(bytes).filter(|sum| *sum <= MAX_HEAP_BYTES)
        })
        .is_err()
    {
        // Terminate the whole helper. No allocation or input-dependent text here.
        std::process::exit(4);
    }
}

unsafe impl GlobalAlloc for Budgeted {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        reserve(layout.size());
        let p = unsafe { System.alloc(layout) };
        if p.is_null() {
            std::process::exit(4);
        }
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        reserve(layout.size());
        let p = unsafe { System.alloc_zeroed(layout) };
        if p.is_null() {
            std::process::exit(4);
        }
        p
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe {
            System.dealloc(ptr, layout);
        }
        LIVE.fetch_sub(layout.size(), Ordering::SeqCst);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // Charge both buffers during realloc; System may allocate/copy before freeing the old block.
        reserve(new_size);
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if p.is_null() {
            std::process::exit(4);
        }
        LIVE.fetch_sub(layout.size(), Ordering::SeqCst);
        p
    }
}

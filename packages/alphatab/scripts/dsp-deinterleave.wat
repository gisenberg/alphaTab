(module
  (memory (export "memory") 1)
  (func (export "deinterleave") (param $source i32) (param $left i32) (param $right i32) (param $frames i32)
    (local $index i32)
    (block $done
      (loop $copy
        (br_if $done (i32.ge_u (local.get $index) (local.get $frames)))
        (f32.store
          (i32.add (local.get $left) (i32.shl (local.get $index) (i32.const 2)))
          (f32.load
            (i32.add (local.get $source) (i32.shl (local.get $index) (i32.const 3)))))
        (f32.store
          (i32.add (local.get $right) (i32.shl (local.get $index) (i32.const 2)))
          (f32.load
            (i32.add
              (i32.add (local.get $source) (i32.shl (local.get $index) (i32.const 3)))
              (i32.const 4))))
        (local.set $index (i32.add (local.get $index) (i32.const 1)))
        (br $copy)))))

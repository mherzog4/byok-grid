(module
  ;; Protocol 1.0 core-Wasm ABI. The host writes the invocation into memory,
  ;; then execute returns (output_pointer << 32) | output_length.
  (memory (export "memory") 1)
  (func (export "alloc") (param $length i32) (result i32)
    i32.const 0)
  (func (export "execute") (param $input_pointer i32) (param $input_length i32) (result i64)
    i64.const 17592186044530)
  (data (i32.const 4096) "{\"protocolVersion\":\"1.0\",\"step\":{\"kind\":\"complete\",\"output\":{\"runtime\":\"wasmtime\",\"isolation\":\"no-host-imports\"}}}"))

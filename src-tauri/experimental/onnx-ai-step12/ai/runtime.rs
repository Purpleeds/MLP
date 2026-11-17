//! ONNX Runtime sessions on the GPU through DirectML (any DirectX 12 card, no CUDA toolkit),
//! falling back to the CPU. Helpers create f32 / f16 tensors to match each model's input type.

use half::f16;
use ort::ep;
use ort::environment::Environment;
use ort::session::Session;
use ort::value::{DynValue, Tensor, TensorElementType};
use std::path::Path;
use std::sync::OnceLock;

static ENV: OnceLock<Environment> = OnceLock::new();

fn env() -> Result<&'static Environment, String> {
    if let Some(e) = ENV.get() {
        return Ok(e);
    }
    let e = ort::init().with_name("mlp").build().map_err(|e| e.to_string())?;
    Ok(ENV.get_or_init(|| e))
}

/// Which device a session ended up on (for diagnostics).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Device {
    DirectML,
    Cpu,
}

pub fn session(path: &Path, gpu: bool) -> Result<(Session, Device), String> {
    let env = env()?;
    if gpu {
        // DirectML needs memory patterns off and sequential execution.
        let built = Session::builder(env)
            .map_err(|e| e.to_string())?
            .with_execution_providers([ep::DirectML::default().build().error_on_failure()])
            .and_then(|b| b.with_memory_pattern(false))
            .and_then(|b| b.with_parallel_execution(false))
            .map_err(|e| e.to_string())
            .and_then(|mut b| b.commit_from_file(path).map_err(|e| e.to_string()));
        match built {
            Ok(s) => return Ok((s, Device::DirectML)),
            Err(e) => eprintln!("[ai] DirectML unavailable ({e}); using the CPU"),
        }
    }
    let s = Session::builder(env)
        .map_err(|e| e.to_string())?
        .commit_from_file(path)
        .map_err(|e| e.to_string())?;
    Ok((s, Device::Cpu))
}

/// Element type a session expects for input `idx`.
pub fn input_type(s: &Session, idx: usize) -> Option<TensorElementType> {
    s.inputs().get(idx).and_then(|o| o.dtype().tensor_type())
}

/// f32 data as a tensor of the requested float type.
pub fn float_tensor(shape: Vec<i64>, data: Vec<f32>, ty: Option<TensorElementType>) -> Result<DynValue, String> {
    match ty {
        Some(TensorElementType::Float16) => {
            let d: Vec<f16> = data.into_iter().map(f16::from_f32).collect();
            Tensor::from_array((shape, d)).map(|t| t.into_dyn()).map_err(|e| e.to_string())
        }
        _ => Tensor::from_array((shape, data)).map(|t| t.into_dyn()).map_err(|e| e.to_string()),
    }
}

/// Read a float output (f32 or f16) as f32, with its shape.
pub fn read_float(v: &DynValue) -> Result<(Vec<i64>, Vec<f32>), String> {
    if let Ok((shape, d)) = v.try_extract_tensor::<f32>() {
        return Ok((shape.to_vec(), d.to_vec()));
    }
    let (shape, d) = v.try_extract_tensor::<f16>().map_err(|e| e.to_string())?;
    Ok((shape.to_vec(), d.iter().map(|x| x.to_f32()).collect()))
}

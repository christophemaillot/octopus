// Octopus Hub — pont Rust entre agents OpenClaw et client desktop
use axum::{routing::get, Router};

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/health", get(|| async { "octopus-hub ok" }));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3700")
        .await
        .expect("bind");

    println!("octopus-hub listening on :3700");
    axum::serve(listener, app).await.unwrap();
}

use std::path::PathBuf;

use anyhow::Context;
use clap::Parser;

#[derive(Parser, Debug)]
struct Cli {
    #[arg(long, default_value = "/etc/stargate/stargate.toml")]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let settings = stargate_gateway::load_settings(&cli.config)
        .with_context(|| format!("failed loading {}", cli.config.display()))?;
    stargate_gateway::run(settings).await
}

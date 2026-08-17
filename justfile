dsh := env_var_or_default("DSH_BIN", "dsh")

# Install dependencies, rebuild generated output, then link this checkout.
install:
    pnpm install
    {{dsh}} plugin --profile web add "{{justfile_directory()}}"

# frozen_string_literal: true

# Run riscv-unified-db's own config validator over many files in one process
# (#589). `udb validate cfg` loads the whole database per invocation; this loads
# it once and calls the same check, ConfiguredArchitecture#valid?, per file.
#
# Run from a riscv-unified-db checkout, with its bundle:
#   bundle exec ruby /path/to/validate.rb <out.json> <config.yaml>...
#
# Writes [{ name, file, valid, reasons[], error? }] to out.json. A file UDB
# cannot even load (it raised) is recorded with `error`, never skipped.

require "json"
require "pathname"
require "udb/resolver"
require "udb/cfg_arch"

out_path = ARGV.shift or abort "usage: validate.rb <out.json> <config.yaml>..."
files = ARGV.map { |f| Pathname.new(f).realpath }
abort "no configurations given" if files.empty?

resolver = Udb::Resolver.new
results = files.map do |file|
  name = file.basename(".yaml").to_s
  started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  begin
    cfg_arch = resolver.cfg_arch_for(file)
    result = cfg_arch.valid?
    { name:, file: file.to_s, valid: result.valid, reasons: result.reasons,
      seconds: (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(1) }
  rescue Exception => e # rubocop:disable Lint/RescueException -- record every failure, including UDB crashes
    raise if e.is_a?(Interrupt)

    { name:, file: file.to_s, valid: false, reasons: [],
      error: "#{e.class}: #{e.message.lines.first&.strip}" }
  ensure
    # The resolver keeps every configured architecture it builds. Over a few
    # hundred files that filled memory and the run slowed to minutes per file,
    # so each is dropped once it has been checked.
    resolver.instance_variable_get(:@cfg_archs)&.clear
    GC.start
    warn format("%-40s %6.1fs", name, Process.clock_gettime(Process::CLOCK_MONOTONIC) - started)
  end
end

File.write(out_path, JSON.pretty_generate(results))
valid = results.count { |r| r[:valid] }
warn "#{valid}/#{results.size} configurations valid; results in #{out_path}"

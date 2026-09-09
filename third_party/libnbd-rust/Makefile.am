# nbd client library in userspace
# Copyright Tage Johansson
#
# This library is free software; you can redistribute it and/or
# modify it under the terms of the GNU Lesser General Public
# License as published by the Free Software Foundation; either
# version 2 of the License, or (at your option) any later version.
#
# This library is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public
# License along with this library; if not, write to the Free Software
# Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA

include $(top_srcdir)/subdir-rules.mk

generator_built = \
	libnbd-sys/src/generated.rs \
	src/async_bindings.rs \
	src/bindings.rs \
	$(NULL)

source_files = \
	$(generator_built) \
	Cargo.toml \
	src/lib.rs \
	src/error.rs \
	src/handle.rs \
	src/types.rs \
	src/utils.rs \
	src/async_handle.rs \
	examples/concurrent-read-write.rs \
	examples/connect-command.rs \
	examples/get-size.rs \
	examples/fetch-first-sector.rs \
	libnbd-sys/Cargo.toml \
	libnbd-sys/build.rs \
	libnbd-sys/src/lib.rs \
	cargo_test/Cargo.toml \
	cargo_test/src/lib.rs \
	cargo_test/README.md \
	tests/nbdkit_pattern/mod.rs \
	tests/test_100_handle.rs \
	tests/test_110_defaults.rs \
	tests/test_120_set_non_defaults.rs \
	tests/test_130_private_data.rs \
	tests/test_140_explicit_close.rs \
	tests/test_200_connect_command.rs \
	tests/test_210_opt_abort.rs \
	tests/test_220_opt_list.rs \
	tests/test_230_opt_info.rs \
	tests/test_240_opt_list_meta.rs \
	tests/test_245_opt_list_meta_queries.rs \
	tests/test_250_opt_set_meta.rs \
	tests/test_255_opt_set_meta_queries.rs \
	tests/test_300_get_size.rs \
	tests/test_400_pread.rs \
	tests/test_405_pread_structured.rs \
	tests/test_410_pwrite.rs \
	tests/test_460_block_status.rs \
	tests/test_465_block_status_64.rs \
	tests/test_620_stats.rs \
	tests/test_async_100_handle.rs \
	tests/test_async_200_connect_command.rs \
	tests/test_async_210_opt_abort.rs \
	tests/test_async_220_opt_list.rs \
	tests/test_async_230_opt_info.rs \
	tests/test_async_240_opt_list_meta.rs \
	tests/test_async_245_opt_list_meta_queries.rs \
	tests/test_async_250_opt_set_meta.rs \
	tests/test_async_255_opt_set_meta_queries.rs \
	tests/test_async_400_pread.rs \
	tests/test_async_405_pread_structured.rs \
	tests/test_async_410_pwrite.rs \
	tests/test_async_460_block_status.rs \
	tests/test_async_465_block_status_64.rs \
	tests/test_async_620_stats.rs \
	tests/test_log/mod.rs \
	run-tests.sh.in \
	$(NULL)

EXTRA_DIST = \
	$(source_files) \
	libnbd-rust.pod \
	$(NULL)

if HAVE_RUST

all-local: libnbd-sys/libnbd_version target/debug/liblibnbd.rlib \
		target/doc/libnbd/index.html \
		target/debug/examples/get-size

libnbd-sys/libnbd_version: Makefile
	rm -f libnbd-sys/libnbd_version.t
	$(abs_top_builddir)/run echo $(VERSION) > libnbd-sys/libnbd_version.t
	mv libnbd-sys/libnbd_version.t libnbd-sys/libnbd_version

target/debug/liblibnbd.rlib: $(source_files)
	$(abs_top_builddir)/run $(CARGO) build

target/doc/libnbd/index.html: $(source_files)
	$(abs_top_builddir)/run $(CARGO) doc

# This will actually build all the examples:
target/debug/examples/get-size: $(source_files)
	$(abs_top_builddir)/run $(CARGO) build --examples

if HAVE_POD

man_MANS = libnbd-rust.3
CLEANFILES += $(man_MANS)

libnbd-rust.3: libnbd-rust.pod $(top_builddir)/podwrapper.pl
	$(PODWRAPPER) --section=3 --man $@ \
	    --html $(top_builddir)/html/$@.html \
	    $<

endif HAVE_POD

TESTS_ENVIRONMENT = \
	LIBNBD_DEBUG=1 \
	$(MALLOC_CHECKS) \
	CARGO=$(CARGO) \
	$(NULL)
LOG_COMPILER = $(top_builddir)/run
TESTS = run-tests.sh

check-valgrind:
	LIBNBD_VALGRIND=1 $(MAKE) check

clean-local:
	$(CARGO) clean
	$(CARGO) clean --manifest-path cargo_test/Cargo.toml

endif HAVE_RUST

CLEANFILES += libnbd-sys/libnbd_version

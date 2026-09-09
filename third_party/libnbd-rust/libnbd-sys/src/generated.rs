/* NBD client library in userspace
 * WARNING: THIS FILE IS GENERATED FROM
 * generator/generator
 * ANY CHANGES YOU MAKE TO THIS FILE WILL BE LOST.
 *
 * Copyright Tage Johansson
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

use libc::*;
use std::ffi::c_void;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct nbd_handle {
    _unused: [u8; 0],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct nbd_extent {
    length: u64,
    flags: u64,
}

extern "C" {
    pub fn nbd_get_error() -> *const c_char;
    pub fn nbd_get_errno() -> c_int;
    pub fn nbd_create() -> *mut nbd_handle;
    pub fn nbd_close(h: *mut nbd_handle);
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct nbd_chunk_callback {
    pub callback: Option<
        unsafe extern "C" fn(
            *mut c_void,
            *const c_void,
            usize,
            u64,
            c_uint,
            *mut c_int,
        ) -> c_int,
    >,
    pub user_data: *mut c_void,
    pub free: Option<unsafe extern "C" fn(*mut c_void)>,
}
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct nbd_completion_callback {
    pub callback:
        Option<unsafe extern "C" fn(*mut c_void, *mut c_int) -> c_int>,
    pub user_data: *mut c_void,
    pub free: Option<unsafe extern "C" fn(*mut c_void)>,
}
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct nbd_debug_callback {
    pub callback: Option<
        unsafe extern "C" fn(
            *mut c_void,
            *const c_char,
            *const c_char,
        ) -> c_int,
    >,
    pub user_data: *mut c_void,
    pub free: Option<unsafe extern "C" fn(*mut c_void)>,
}
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct nbd_extent_callback {
    pub callback: Option<
        unsafe extern "C" fn(
            *mut c_void,
            *const c_char,
            u64,
            *mut u32,
            usize,
            *mut c_int,
        ) -> c_int,
    >,
    pub user_data: *mut c_void,
    pub free: Option<unsafe extern "C" fn(*mut c_void)>,
}
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct nbd_extent64_callback {
    pub callback: Option<
        unsafe extern "C" fn(
            *mut c_void,
            *const c_char,
            u64,
            *mut nbd_extent,
            usize,
            *mut c_int,
        ) -> c_int,
    >,
    pub user_data: *mut c_void,
    pub free: Option<unsafe extern "C" fn(*mut c_void)>,
}
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct nbd_list_callback {
    pub callback: Option<
        unsafe extern "C" fn(
            *mut c_void,
            *const c_char,
            *const c_char,
        ) -> c_int,
    >,
    pub user_data: *mut c_void,
    pub free: Option<unsafe extern "C" fn(*mut c_void)>,
}
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct nbd_context_callback {
    pub callback:
        Option<unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int>,
    pub user_data: *mut c_void,
    pub free: Option<unsafe extern "C" fn(*mut c_void)>,
}
extern "C" {
    pub fn nbd_set_debug(handle: *mut nbd_handle, debug: bool) -> c_int;
    pub fn nbd_get_debug(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_set_debug_callback(
        handle: *mut nbd_handle,
        debug: nbd_debug_callback,
    ) -> c_int;
    pub fn nbd_clear_debug_callback(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_stats_bytes_sent(handle: *mut nbd_handle) -> u64;
    pub fn nbd_stats_chunks_sent(handle: *mut nbd_handle) -> u64;
    pub fn nbd_stats_bytes_received(handle: *mut nbd_handle) -> u64;
    pub fn nbd_stats_chunks_received(handle: *mut nbd_handle) -> u64;
    pub fn nbd_set_handle_name(
        handle: *mut nbd_handle,
        handle_name: *const c_char,
    ) -> c_int;
    pub fn nbd_get_handle_name(handle: *mut nbd_handle) -> *mut c_char;
    pub fn nbd_set_private_data(
        handle: *mut nbd_handle,
        private_data: uintptr_t,
    ) -> uintptr_t;
    pub fn nbd_get_private_data(handle: *mut nbd_handle) -> uintptr_t;
    pub fn nbd_set_export_name(
        handle: *mut nbd_handle,
        export_name: *const c_char,
    ) -> c_int;
    pub fn nbd_get_export_name(handle: *mut nbd_handle) -> *mut c_char;
    pub fn nbd_set_request_block_size(
        handle: *mut nbd_handle,
        request: bool,
    ) -> c_int;
    pub fn nbd_get_request_block_size(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_set_full_info(handle: *mut nbd_handle, request: bool) -> c_int;
    pub fn nbd_get_full_info(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_get_canonical_export_name(
        handle: *mut nbd_handle,
    ) -> *mut c_char;
    pub fn nbd_get_export_description(handle: *mut nbd_handle) -> *mut c_char;
    pub fn nbd_set_tls(handle: *mut nbd_handle, tls: c_int) -> c_int;
    pub fn nbd_get_tls(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_get_tls_negotiated(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_set_tls_certificates(
        handle: *mut nbd_handle,
        dir: *const c_char,
    ) -> c_int;
    pub fn nbd_set_tls_verify_peer(
        handle: *mut nbd_handle,
        verify: bool,
    ) -> c_int;
    pub fn nbd_get_tls_verify_peer(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_set_tls_username(
        handle: *mut nbd_handle,
        username: *const c_char,
    ) -> c_int;
    pub fn nbd_get_tls_username(handle: *mut nbd_handle) -> *mut c_char;
    pub fn nbd_set_tls_hostname(
        handle: *mut nbd_handle,
        hostname: *const c_char,
    ) -> c_int;
    pub fn nbd_get_tls_hostname(handle: *mut nbd_handle) -> *mut c_char;
    pub fn nbd_set_tls_psk_file(
        handle: *mut nbd_handle,
        filename: *const c_char,
    ) -> c_int;
    pub fn nbd_set_request_extended_headers(
        handle: *mut nbd_handle,
        request: bool,
    ) -> c_int;
    pub fn nbd_get_request_extended_headers(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_get_extended_headers_negotiated(
        handle: *mut nbd_handle,
    ) -> c_int;
    pub fn nbd_set_request_structured_replies(
        handle: *mut nbd_handle,
        request: bool,
    ) -> c_int;
    pub fn nbd_get_request_structured_replies(handle: *mut nbd_handle)
        -> c_int;
    pub fn nbd_get_structured_replies_negotiated(
        handle: *mut nbd_handle,
    ) -> c_int;
    pub fn nbd_set_request_meta_context(
        handle: *mut nbd_handle,
        request: bool,
    ) -> c_int;
    pub fn nbd_get_request_meta_context(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_set_handshake_flags(
        handle: *mut nbd_handle,
        flags: u32,
    ) -> c_int;
    pub fn nbd_get_handshake_flags(handle: *mut nbd_handle) -> u32;
    pub fn nbd_set_pread_initialize(
        handle: *mut nbd_handle,
        request: bool,
    ) -> c_int;
    pub fn nbd_get_pread_initialize(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_set_strict_mode(handle: *mut nbd_handle, flags: u32) -> c_int;
    pub fn nbd_get_strict_mode(handle: *mut nbd_handle) -> u32;
    pub fn nbd_set_opt_mode(handle: *mut nbd_handle, enable: bool) -> c_int;
    pub fn nbd_get_opt_mode(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_opt_go(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_opt_abort(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_opt_starttls(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_opt_extended_headers(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_opt_structured_reply(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_opt_list(
        handle: *mut nbd_handle,
        list: nbd_list_callback,
    ) -> c_int;
    pub fn nbd_opt_info(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_opt_list_meta_context(
        handle: *mut nbd_handle,
        context: nbd_context_callback,
    ) -> c_int;
    pub fn nbd_opt_list_meta_context_queries(
        handle: *mut nbd_handle,
        queries: *mut *mut c_char,
        context: nbd_context_callback,
    ) -> c_int;
    pub fn nbd_opt_set_meta_context(
        handle: *mut nbd_handle,
        context: nbd_context_callback,
    ) -> c_int;
    pub fn nbd_opt_set_meta_context_queries(
        handle: *mut nbd_handle,
        queries: *mut *mut c_char,
        context: nbd_context_callback,
    ) -> c_int;
    pub fn nbd_add_meta_context(
        handle: *mut nbd_handle,
        name: *const c_char,
    ) -> c_int;
    pub fn nbd_get_nr_meta_contexts(handle: *mut nbd_handle) -> isize;
    pub fn nbd_get_meta_context(
        handle: *mut nbd_handle,
        i: size_t,
    ) -> *mut c_char;
    pub fn nbd_clear_meta_contexts(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_set_uri_allow_transports(
        handle: *mut nbd_handle,
        mask: u32,
    ) -> c_int;
    pub fn nbd_set_uri_allow_tls(handle: *mut nbd_handle, tls: c_int) -> c_int;
    pub fn nbd_set_uri_allow_local_file(
        handle: *mut nbd_handle,
        allow: bool,
    ) -> c_int;
    pub fn nbd_connect_uri(
        handle: *mut nbd_handle,
        uri: *const c_char,
    ) -> c_int;
    pub fn nbd_connect_unix(
        handle: *mut nbd_handle,
        unixsocket: *const c_char,
    ) -> c_int;
    pub fn nbd_connect_vsock(
        handle: *mut nbd_handle,
        cid: u32,
        port: u32,
    ) -> c_int;
    pub fn nbd_connect_tcp(
        handle: *mut nbd_handle,
        hostname: *const c_char,
        port: *const c_char,
    ) -> c_int;
    pub fn nbd_connect_socket(handle: *mut nbd_handle, sock: c_int) -> c_int;
    pub fn nbd_connect_command(
        handle: *mut nbd_handle,
        argv: *mut *mut c_char,
    ) -> c_int;
    pub fn nbd_connect_systemd_socket_activation(
        handle: *mut nbd_handle,
        argv: *mut *mut c_char,
    ) -> c_int;
    pub fn nbd_set_socket_activation_name(
        handle: *mut nbd_handle,
        socket_name: *const c_char,
    ) -> c_int;
    pub fn nbd_get_socket_activation_name(
        handle: *mut nbd_handle,
    ) -> *mut c_char;
    pub fn nbd_is_read_only(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_can_flush(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_can_fua(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_is_rotational(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_can_trim(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_can_zero(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_can_fast_zero(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_can_block_status_payload(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_can_df(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_can_multi_conn(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_can_cache(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_can_meta_context(
        handle: *mut nbd_handle,
        metacontext: *const c_char,
    ) -> c_int;
    pub fn nbd_get_protocol(handle: *mut nbd_handle) -> *const c_char;
    pub fn nbd_get_size(handle: *mut nbd_handle) -> i64;
    pub fn nbd_get_block_size(handle: *mut nbd_handle, size_type: c_int)
        -> i64;
    pub fn nbd_pread(
        handle: *mut nbd_handle,
        buf: *mut c_void,
        count: usize,
        offset: u64,
        flags: u32,
    ) -> c_int;
    pub fn nbd_pread_structured(
        handle: *mut nbd_handle,
        buf: *mut c_void,
        count: usize,
        offset: u64,
        chunk: nbd_chunk_callback,
        flags: u32,
    ) -> c_int;
    pub fn nbd_pwrite(
        handle: *mut nbd_handle,
        buf: *const c_void,
        count: usize,
        offset: u64,
        flags: u32,
    ) -> c_int;
    pub fn nbd_shutdown(handle: *mut nbd_handle, flags: u32) -> c_int;
    pub fn nbd_flush(handle: *mut nbd_handle, flags: u32) -> c_int;
    pub fn nbd_trim(
        handle: *mut nbd_handle,
        count: u64,
        offset: u64,
        flags: u32,
    ) -> c_int;
    pub fn nbd_cache(
        handle: *mut nbd_handle,
        count: u64,
        offset: u64,
        flags: u32,
    ) -> c_int;
    pub fn nbd_zero(
        handle: *mut nbd_handle,
        count: u64,
        offset: u64,
        flags: u32,
    ) -> c_int;
    pub fn nbd_block_status(
        handle: *mut nbd_handle,
        count: u64,
        offset: u64,
        extent: nbd_extent_callback,
        flags: u32,
    ) -> c_int;
    pub fn nbd_block_status_64(
        handle: *mut nbd_handle,
        count: u64,
        offset: u64,
        extent64: nbd_extent64_callback,
        flags: u32,
    ) -> c_int;
    pub fn nbd_block_status_filter(
        handle: *mut nbd_handle,
        count: u64,
        offset: u64,
        contexts: *mut *mut c_char,
        extent64: nbd_extent64_callback,
        flags: u32,
    ) -> c_int;
    pub fn nbd_poll(handle: *mut nbd_handle, timeout: c_int) -> c_int;
    pub fn nbd_poll2(
        handle: *mut nbd_handle,
        fd: c_int,
        timeout: c_int,
    ) -> c_int;
    pub fn nbd_aio_connect(
        handle: *mut nbd_handle,
        addr: *const sockaddr,
        addrlen: socklen_t,
    ) -> c_int;
    pub fn nbd_aio_connect_uri(
        handle: *mut nbd_handle,
        uri: *const c_char,
    ) -> c_int;
    pub fn nbd_aio_connect_unix(
        handle: *mut nbd_handle,
        unixsocket: *const c_char,
    ) -> c_int;
    pub fn nbd_aio_connect_vsock(
        handle: *mut nbd_handle,
        cid: u32,
        port: u32,
    ) -> c_int;
    pub fn nbd_aio_connect_tcp(
        handle: *mut nbd_handle,
        hostname: *const c_char,
        port: *const c_char,
    ) -> c_int;
    pub fn nbd_aio_connect_socket(
        handle: *mut nbd_handle,
        sock: c_int,
    ) -> c_int;
    pub fn nbd_aio_connect_command(
        handle: *mut nbd_handle,
        argv: *mut *mut c_char,
    ) -> c_int;
    pub fn nbd_aio_connect_systemd_socket_activation(
        handle: *mut nbd_handle,
        argv: *mut *mut c_char,
    ) -> c_int;
    pub fn nbd_aio_opt_go(
        handle: *mut nbd_handle,
        completion: nbd_completion_callback,
    ) -> c_int;
    pub fn nbd_aio_opt_abort(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_aio_opt_starttls(
        handle: *mut nbd_handle,
        completion: nbd_completion_callback,
    ) -> c_int;
    pub fn nbd_aio_opt_extended_headers(
        handle: *mut nbd_handle,
        completion: nbd_completion_callback,
    ) -> c_int;
    pub fn nbd_aio_opt_structured_reply(
        handle: *mut nbd_handle,
        completion: nbd_completion_callback,
    ) -> c_int;
    pub fn nbd_aio_opt_list(
        handle: *mut nbd_handle,
        list: nbd_list_callback,
        completion: nbd_completion_callback,
    ) -> c_int;
    pub fn nbd_aio_opt_info(
        handle: *mut nbd_handle,
        completion: nbd_completion_callback,
    ) -> c_int;
    pub fn nbd_aio_opt_list_meta_context(
        handle: *mut nbd_handle,
        context: nbd_context_callback,
        completion: nbd_completion_callback,
    ) -> c_int;
    pub fn nbd_aio_opt_list_meta_context_queries(
        handle: *mut nbd_handle,
        queries: *mut *mut c_char,
        context: nbd_context_callback,
        completion: nbd_completion_callback,
    ) -> c_int;
    pub fn nbd_aio_opt_set_meta_context(
        handle: *mut nbd_handle,
        context: nbd_context_callback,
        completion: nbd_completion_callback,
    ) -> c_int;
    pub fn nbd_aio_opt_set_meta_context_queries(
        handle: *mut nbd_handle,
        queries: *mut *mut c_char,
        context: nbd_context_callback,
        completion: nbd_completion_callback,
    ) -> c_int;
    pub fn nbd_aio_pread(
        handle: *mut nbd_handle,
        buf: *mut c_void,
        count: usize,
        offset: u64,
        completion: nbd_completion_callback,
        flags: u32,
    ) -> i64;
    pub fn nbd_aio_pread_structured(
        handle: *mut nbd_handle,
        buf: *mut c_void,
        count: usize,
        offset: u64,
        chunk: nbd_chunk_callback,
        completion: nbd_completion_callback,
        flags: u32,
    ) -> i64;
    pub fn nbd_aio_pwrite(
        handle: *mut nbd_handle,
        buf: *const c_void,
        count: usize,
        offset: u64,
        completion: nbd_completion_callback,
        flags: u32,
    ) -> i64;
    pub fn nbd_aio_disconnect(handle: *mut nbd_handle, flags: u32) -> c_int;
    pub fn nbd_aio_flush(
        handle: *mut nbd_handle,
        completion: nbd_completion_callback,
        flags: u32,
    ) -> i64;
    pub fn nbd_aio_trim(
        handle: *mut nbd_handle,
        count: u64,
        offset: u64,
        completion: nbd_completion_callback,
        flags: u32,
    ) -> i64;
    pub fn nbd_aio_cache(
        handle: *mut nbd_handle,
        count: u64,
        offset: u64,
        completion: nbd_completion_callback,
        flags: u32,
    ) -> i64;
    pub fn nbd_aio_zero(
        handle: *mut nbd_handle,
        count: u64,
        offset: u64,
        completion: nbd_completion_callback,
        flags: u32,
    ) -> i64;
    pub fn nbd_aio_block_status(
        handle: *mut nbd_handle,
        count: u64,
        offset: u64,
        extent: nbd_extent_callback,
        completion: nbd_completion_callback,
        flags: u32,
    ) -> i64;
    pub fn nbd_aio_block_status_64(
        handle: *mut nbd_handle,
        count: u64,
        offset: u64,
        extent64: nbd_extent64_callback,
        completion: nbd_completion_callback,
        flags: u32,
    ) -> i64;
    pub fn nbd_aio_block_status_filter(
        handle: *mut nbd_handle,
        count: u64,
        offset: u64,
        contexts: *mut *mut c_char,
        extent64: nbd_extent64_callback,
        completion: nbd_completion_callback,
        flags: u32,
    ) -> i64;
    pub fn nbd_aio_get_fd(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_aio_get_direction(handle: *mut nbd_handle) -> c_uint;
    pub fn nbd_aio_notify_read(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_aio_notify_write(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_aio_is_created(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_aio_is_connecting(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_aio_is_negotiating(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_aio_is_ready(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_aio_is_processing(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_aio_is_dead(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_aio_is_closed(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_aio_command_completed(
        handle: *mut nbd_handle,
        cookie: u64,
    ) -> c_int;
    pub fn nbd_aio_peek_command_completed(handle: *mut nbd_handle) -> i64;
    pub fn nbd_aio_in_flight(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_connection_state(handle: *mut nbd_handle) -> *const c_char;
    pub fn nbd_get_package_name(handle: *mut nbd_handle) -> *const c_char;
    pub fn nbd_get_version(handle: *mut nbd_handle) -> *const c_char;
    pub fn nbd_kill_subprocess(handle: *mut nbd_handle, signum: c_int)
        -> c_int;
    pub fn nbd_get_subprocess_pid(handle: *mut nbd_handle) -> i64;
    pub fn nbd_supports_tls(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_supports_vsock(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_supports_uri(handle: *mut nbd_handle) -> c_int;
    pub fn nbd_get_uri(handle: *mut nbd_handle) -> *mut c_char;
    pub fn nbd_is_uri(handle: *mut nbd_handle, uri: *const c_char) -> c_int;
}

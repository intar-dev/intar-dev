// libnbd Rust test case
// Copyright Tage Johansson
//
// This library is free software; you can redistribute it and/or
// modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.
//
// This library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public
// License along with this library; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA

#![deny(warnings)]

use std::fs::{self, File};

#[tokio::test]
async fn test_async_pwrite() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let data_file_path = tmp_dir.path().join("pwrite_test.data");
    let data_file = File::create(&data_file_path).unwrap();
    data_file.set_len(512).unwrap();
    drop(data_file);
    let nbd = libnbd::AsyncHandle::new().unwrap();
    nbd.connect_command(&[
        "nbdkit",
        "-s",
        "--exit-with-parent",
        "-v",
        "file",
        data_file_path.to_str().unwrap(),
    ])
    .await
    .unwrap();

    let mut buf_1 = [0; 512];
    buf_1[10] = 0x01;
    buf_1[510] = 0x55;
    buf_1[511] = 0xAA;

    let flags = Some(libnbd::CmdFlag::FUA);
    nbd.pwrite(&buf_1, 0, flags).await.unwrap();

    let mut buf_2 = [0; 512];
    nbd.pread(&mut buf_2, 0, None).await.unwrap();

    assert_eq!(buf_1, buf_2);

    // Drop nbd before tmp_dir is dropped.
    drop(nbd);

    let data_file_content = fs::read(&data_file_path).unwrap();
    assert_eq!(buf_1.as_slice(), data_file_content.as_slice());
}

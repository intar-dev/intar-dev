import contextlib
from concurrent.futures import ThreadPoolExecutor
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import stat
import tarfile
import tempfile
import types
import unittest
from unittest.mock import mock_open, patch

SOURCE = Path(__file__).with_name('intar-host')
loader = importlib.machinery.SourceFileLoader('intar_host', str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
host = importlib.util.module_from_spec(spec)
loader.exec_module(host)
REPO = Path(__file__).resolve().parents[2]


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in {
            'ROOT': self.root, 'STATE': self.root / 'state.json',
            'ENROLLMENT': self.root / 'enrollment.json',
            'CREDENTIAL': self.root / 'credential.json', 'CONFIG': self.root / 'config.toml',
            'JAILER_CONFIG': self.root / 'jailerd/config.toml',
            'MAINTENANCE': self.root / 'maintenance', 'STORAGE': self.root / 'storage',
            'IMAGE': self.root / 'storage.xfs', 'COMMAND': self.root / 'intar-host',
        }.items():
            self.stack.enter_context(patch.object(host, name, value))
        # The portable harness runs without root. Production path checks have separate tests.
        self.stack.enter_context(patch.object(host, 'secure_path', side_effect=lambda p, **kw: Path(p).lstat()))
        self.stack.enter_context(patch.object(host.os, 'fchown'))
        self.stack.enter_context(patch.object(host.os, 'chown'))
        self.identity = {'hostId': 'host_1', 'ownerUserId': 'user_1', 'scope': 'personal', 'credentialGeneration': 1}

    def test_preflight_requires_ubuntu_at_least_24_04(self):
        files = {
            '/proc/1/comm': 'systemd\n', '/proc/meminfo': 'MemTotal: 4194304 kB\n',
            '/sys/fs/cgroup/cgroup.controllers': 'cpu memory\n',
        }
        for distribution, version, accepted in (
            ('ubuntu', '24.04', True), ('ubuntu', '24.10', True), ('ubuntu', '26.04', True),
            ('ubuntu', '100.04', True), ('ubuntu', '22.04', False), ('ubuntu', '24.03', False),
            ('ubuntu', '9.10', False), ('ubuntu', '', False), ('ubuntu', '24.x', False),
            ('ubuntu', '26.04extra', False), ('debian', '26.04', False),
        ):
            files['/etc/os-release'] = f'ID={distribution}\nVERSION_ID="{version}"\n'
            with self.subTest(distribution=distribution, version=version), \
                 patch.object(host.platform, 'system', return_value='Linux'), \
                 patch.object(host.platform, 'machine', return_value='x86_64'), \
                 patch.object(Path, 'read_text', autospec=True, side_effect=lambda path: files[str(path)]), \
                 patch.object(host, 'run'), \
                 patch.object(host.os, 'sched_getaffinity', return_value={0, 1}, create=True), \
                 patch.object(Path, 'exists', return_value=True), \
                 patch.object(Path, 'stat', return_value=types.SimpleNamespace(st_mode=stat.S_IFCHR)), \
                 patch('builtins.open', mock_open()), \
                 patch.object(host.fcntl, 'ioctl', return_value=12):
                if accepted:
                    host.preflight()
                else:
                    with self.assertRaisesRegex(host.HostError, 'Ubuntu 24.04 or later is required'):
                        host.preflight()

    def test_dependencies_use_minimum_versions_and_reject_invalid_locks(self):
        lock = self.root / 'deploy/personal-metal/dependencies.lock'
        lock.parent.mkdir(parents=True)
        lock.write_text('python3=3.12.3-0ubuntu2\nxfsprogs=6.6.0-1ubuntu2\n')
        with patch.object(host, 'run') as run:
            host.install_dependencies(self.root)
        self.assertEqual(run.call_args_list, [
            unittest.mock.call('apt-get', 'update'),
            unittest.mock.call('apt-get', 'satisfy', '--yes', '--no-install-recommends',
                               'python3 (>= 3.12.3-0ubuntu2)', 'xfsprogs (>= 6.6.0-1ubuntu2)'),
        ])
        for invalid in ('', 'python3', 'python3=3.12 | other', 'python3=3.12\n--allow-unauthenticated'):
            with self.subTest(invalid=invalid), patch.object(host, 'run') as run:
                lock.write_text(invalid)
                with self.assertRaisesRegex(host.HostError, 'Invalid package dependency lock'):
                    host.install_dependencies(self.root)
                run.assert_not_called()

    def test_identity_range_avoids_accounts_groups_and_subordinate_ids(self):
        with patch.object(host.pwd, 'getpwall', return_value=[types.SimpleNamespace(pw_uid=320000)]), \
             patch.object(host.grp, 'getgrall', return_value=[types.SimpleNamespace(gr_gid=300000)]), \
             patch.object(Path, 'exists', return_value=True), \
             patch.object(Path, 'read_text', side_effect=[
                 'ubuntu:100000:65536\nrunner:165536:65536\n', 'runner:231072:65536\n']):
            self.assertEqual(host.available_identity_range(), (320001, 385536))

    def test_identity_range_rejects_invalid_subordinate_allocation(self):
        with patch.object(host.pwd, 'getpwall', return_value=[]), \
             patch.object(host.grp, 'getgrall', return_value=[]), \
             patch.object(Path, 'exists', return_value=True), \
             patch.object(Path, 'read_text', return_value='runner:165536:invalid\n'):
            with self.assertRaisesRegex(host.HostError, 'Invalid identity allocation'):
                host.available_identity_range()

    def test_configure_preserves_allocated_identities_on_retry_and_update(self):
        package = self.root / 'package'
        (package / 'deploy').mkdir(parents=True)
        (package / 'deploy/config.example.toml').write_text(
            (REPO / 'crates/intar-jailerd/deploy/config.example.toml').read_text())
        account = types.SimpleNamespace(pw_uid=42, pw_gid=42)
        with patch.object(host, 'enroll'), \
             patch.object(host, 'available_identity_range', return_value=(320001, 385536)) as allocate:
            host.configure(package, account)
            host.configure(package, account)
            allocate.assert_called_once()
        config = host.tomllib.loads(host.JAILER_CONFIG.read_text())
        self.assertEqual((config['uid_gid_start'], config['uid_gid_end']), (320001, 385536))
        self.assertFalse(config['allow_uid_gid_collisions'])

    def test_credential_and_token_are_durable_before_http(self):
        checkpoints = []
        real_sync = host.sync_dir
        def synced(path):
            real_sync(path)
            checkpoints.append('sync')
        def claim(enrollment):
            self.assertEqual(json.loads(host.ENROLLMENT.read_text()), enrollment)
            self.assertRegex(enrollment['credential'], '^[a-f0-9]{64}$')
            self.assertEqual(stat.S_IMODE(host.ENROLLMENT.stat().st_mode), 0o600)
            self.assertTrue(checkpoints)
            return self.identity
        with patch.object(host, 'read_token', return_value='a' * 64), patch.object(host, 'claim', side_effect=claim), patch.object(host, 'sync_dir', side_effect=synced):
            host.enroll(42)
        self.assertNotIn('enrollmentToken', json.loads(host.ENROLLMENT.read_text()))
        self.assertEqual(json.loads(host.CREDENTIAL.read_text())['hostId'], 'host_1')

    def test_lost_response_reuses_the_same_claim(self):
        attempts = []
        def claim(value):
            attempts.append(dict(value))
            if len(attempts) == 1:
                raise host.HostError('lost response')
            return self.identity
        with patch.object(host, 'read_token', return_value='b' * 64) as prompt, patch.object(host, 'claim', side_effect=claim):
            with self.assertRaises(host.HostError):
                host.enroll(42)
            host.enroll(42)
            self.assertEqual(prompt.call_count, 1)
        self.assertEqual(attempts[0], attempts[1])

    def test_failed_credential_sync_prevents_enrollment_request(self):
        with patch.object(host, 'read_token', return_value='b' * 64), patch.object(host.os, 'fsync', side_effect=OSError('disk')), patch.object(host, 'claim') as claim:
            with self.assertRaises(OSError):
                host.enroll(42)
        claim.assert_not_called()

    def test_crash_after_claim_does_not_reenroll(self):
        real_atomic = host.atomic
        def fail_credential(path, *args):
            if path == host.CREDENTIAL:
                raise OSError('disk failure')
            return real_atomic(path, *args)
        with patch.object(host, 'read_token', return_value='a' * 64), patch.object(host, 'claim', return_value=self.identity) as claim:
            with patch.object(host, 'atomic', side_effect=fail_credential):
                with self.assertRaises(OSError):
                    host.enroll(42)
            host.enroll(42)
            self.assertEqual(claim.call_count, 1)

    def test_atomic_failure_leaves_original_file_and_no_temporary_file(self):
        path = self.root / 'secret'
        host.atomic(path, 'original')
        with patch.object(host.os, 'replace', side_effect=OSError('disk')):
            with self.assertRaises(OSError):
                host.atomic(path, 'replacement')
        self.assertEqual(path.read_text(), 'original')
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_enrollment_never_uses_a_subprocess(self):
        with patch.object(host, 'read_token', return_value='a' * 64), patch.object(host, 'claim', return_value=self.identity), patch.object(host.subprocess, 'run') as process:
            host.enroll(42)
        process.assert_not_called()

    def test_redirect_is_rejected(self):
        with self.assertRaises(host.HostError):
            host.NoRedirect().redirect_request(None, None, None, None, None, None)

    def test_claim_does_not_print_server_error(self):
        client = types.SimpleNamespace(open=lambda *a, **k: (_ for _ in ()).throw(OSError('secret-a')))
        with patch.object(host.urllib.request, 'build_opener', return_value=client):
            with self.assertRaises(host.HostError) as error:
                host.claim({'credential': 'secret-a', 'enrollmentToken': 'secret-b'})
        self.assertNotIn('secret', str(error.exception))

    def test_rejected_claim_keeps_its_identity_and_gives_a_repair_path(self):
        for status in (401, 503):
            failure = host.urllib.error.HTTPError('https://secret.invalid', status, 'secret', {}, io.BytesIO(b'secret'))
            client = types.SimpleNamespace(open=lambda *a, **k: (_ for _ in ()).throw(failure))
            with self.subTest(status=status), patch.object(host, 'read_token', return_value='a' * 64) as prompt, patch.object(host.urllib.request, 'build_opener', return_value=client):
                with self.assertRaises(host.HostError) as error:
                    host.enroll(42)
                saved = host.ENROLLMENT.read_bytes()
                with self.assertRaises(host.HostError):
                    host.enroll(42)
                self.assertEqual(host.ENROLLMENT.read_bytes(), saved)
                self.assertFalse(host.CREDENTIAL.exists())
                self.assertLessEqual(prompt.call_count, 1)
                self.assertNotIn('secret', str(error.exception))
                self.assertIn('#register-again' if status == 401 else 'Repeat setup', str(error.exception))

    def test_claim_validates_identity_scope_and_generation(self):
        for change in ({'scope': 'platform'}, {'hostId': '../bad'}, {'ownerUserId': ''}, {'credentialGeneration': 2}):
            response = io.BytesIO(json.dumps({**self.identity, **change}).encode())
            client = types.SimpleNamespace(open=lambda *a, **k: response)
            with self.subTest(change=change), patch.object(host.urllib.request, 'build_opener', return_value=client):
                with self.assertRaises(host.HostError):
                    host.claim({'credential': 'a' * 64, 'enrollmentToken': 'b' * 64})

    def test_token_does_not_fallback_to_standard_input(self):
        with patch('builtins.open', side_effect=OSError('no tty')), patch.object(host.sys, 'stdin', io.StringIO('a' * 64)):
            with self.assertRaises(OSError):
                host.read_token()
            self.assertEqual(host.sys.stdin.tell(), 0)

    def test_token_prompt_uses_a_real_terminal_without_echo(self):
        master, slave = os.openpty()
        original_open = open
        previous = host.termios.tcgetattr(slave)
        def terminal_open(path, *args, **kwargs):
            return original_open(os.ttyname(slave) if path == '/dev/tty' else path, *args, **kwargs)
        with ThreadPoolExecutor(max_workers=1) as executor:
            try:
                with patch('builtins.open', side_effect=terminal_open):
                    result = executor.submit(host.read_token)
                    self.assertTrue(select.select([master], [], [], 5)[0], 'Token prompt was not flushed')
                    self.assertEqual(os.read(master, 1024), b'Paste the token from My servers: ')
                    self.assertFalse(host.termios.tcgetattr(slave)[3] & host.termios.ECHO)
                    os.write(master, b'a' * 64 + b'\n')
                    self.assertEqual(result.result(timeout=5), 'a' * 64)
                    self.assertEqual(host.termios.tcgetattr(slave), previous)
                    self.assertTrue(select.select([master], [], [], 5)[0])
                    self.assertEqual(os.read(master, 1024).replace(b'\r', b''), b'\n')
            finally:
                os.close(master)
                os.close(slave)

    def test_archive_rejects_links_devices_traversal_and_duplicates(self):
        cases = [('../outside', tarfile.REGTYPE), ('/outside', tarfile.REGTYPE),
                 ('link', tarfile.SYMTYPE), ('hard', tarfile.LNKTYPE), ('device', tarfile.CHRTYPE),
                 ('duplicate', tarfile.REGTYPE)]
        for name, kind in cases:
            archive = self.root / 'archive.tar.gz'
            with tarfile.open(archive, 'w:gz') as bundle:
                item = tarfile.TarInfo(name)
                item.type = kind
                item.linkname = '/etc/passwd' if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ''
                bundle.addfile(item)
                if name == 'duplicate':
                    bundle.addfile(item)
            with self.subTest(name=name), self.assertRaises(host.HostError):
                host.extract(archive, self.root / 'extract')

    def test_checksum_duplicates_rejected(self):
        with self.assertRaises(host.HostError):
            host.checksums(('a' * 64 + '  file\n') * 2)

    def test_unlisted_or_modified_release_files_rejected(self):
        package = self.root / 'package'
        (package / 'deploy').mkdir(parents=True)
        (package / 'deploy/SHA256SUMS').write_text('')
        (package / 'extra').write_text('payload')
        with self.assertRaises(host.HostError):
            host.verify_package(package)

    def test_version_pin_is_saved_before_download(self):
        state = {}
        def fail_download(*args):
            self.assertEqual(host.load(host.STATE)['pendingVersion'], '1.2.3')
            raise host.HostError('offline')
        with patch.object(host, 'download', side_effect=fail_download):
            with self.assertRaises(host.HostError):
                host.package_for(state, '1.2.3')
        with patch.object(host, 'latest_version') as latest, patch.object(host, 'download', side_effect=fail_download):
            with self.assertRaises(host.HostError):
                host.package_for(state)
            latest.assert_not_called()

    def test_invalid_version_is_rejected_before_download(self):
        for value in ('../1', '1.2.3?token=bad', '-x', 'v1.2.3'):
            with self.subTest(value=value), self.assertRaises(host.HostError):
                host.package_for({}, value)

    def test_drain_timeout_keeps_agent_and_binaries(self):
        events = []
        with patch.object(host, 'active', return_value=True), patch.object(host, 'agent', side_effect=lambda arg: events.append(arg) or json.dumps({'draining': True, 'trackedVms': 1})), patch.object(host.time, 'monotonic', side_effect=[0, 2]), patch.object(host, 'run') as run:
            with self.assertRaises(host.HostError):
                host.drain({}, 1)
        self.assertEqual(events, ['--drain', '--status'])
        self.assertTrue(host.MAINTENANCE.exists())
        run.assert_not_called()

    def test_drain_retries_admission_lock_and_checks_vms_after_stop(self):
        events = []
        answers = iter([host.HostError('busy'), '', json.dumps({'draining': True, 'trackedVms': 0})])
        def agent(arg):
            events.append(arg)
            value = next(answers)
            if isinstance(value, Exception):
                raise value
            return value
        with patch.object(host, 'active', return_value=True), patch.object(host, 'agent', side_effect=agent), patch.object(host.time, 'sleep'), patch.object(host, 'run', side_effect=lambda *a, **k: events.append(a)), patch.object(host, 'no_vms', side_effect=lambda: events.append('no_vms')):
            host.drain({}, 60)
        self.assertEqual(events, ['--drain', '--drain', '--status', ('systemctl', 'stop', 'intar-agent.service'), 'no_vms'])

    def test_storage_never_formats_existing_file(self):
        host.IMAGE.write_bytes(b'valuable data')
        with patch.object(host, 'reflink', return_value=False), patch.object(host.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=200 * host.GIB)), patch.object(host, 'run') as run:
            with self.assertRaises(FileExistsError):
                host.storage({})
        self.assertEqual(host.IMAGE.read_bytes(), b'valuable data')
        run.assert_not_called()

    def test_unknown_vmm_with_live_kvm_fd_is_rejected(self):
        process = self.root / 'proc/123'
        (process / 'fd').mkdir(parents=True)
        (process / 'exe').symlink_to('/usr/local/bin/custom-vmm')
        (process / 'fd/4').symlink_to('anon_inode:kvm-vm')
        def path(value):
            return self.root / 'proc' if value == '/proc' else Path(value)
        with patch.object(host, 'Path', side_effect=path), patch.object(host, 'run', return_value=''):
            with self.assertRaisesRegex(host.HostError, 'active KVM'):
                host.no_vms()

    def test_storage_reserve_checked_before_file_creation(self):
        with patch.object(host, 'reflink', return_value=False), patch.object(host.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=109 * host.GIB)), patch.object(host, 'run') as run:
            with self.assertRaises(host.HostError):
                host.storage({})
        self.assertFalse(host.IMAGE.exists())
        run.assert_not_called()

    def test_storage_inode_mismatch_prevents_format(self):
        host.IMAGE.write_bytes(b'valuable data')
        state = {'storage': {'kind': 'loop', 'inode': -1, 'device': -1, 'initialized': False}}
        with patch.object(host, 'run') as run:
            with self.assertRaises(host.HostError):
                host.storage(state)
        run.assert_not_called()

    def test_mount_unit_has_boot_order_and_requires_source_mount(self):
        unit_root = self.root / 'units'
        unit_root.mkdir()
        with patch.object(host, 'UNITS', unit_root), patch.object(host, 'mount_name', return_value='test.mount'), patch.object(host, 'run'), patch.object(host, 'is_mounted', return_value=True), patch.object(host.os.path, 'samefile', return_value=True):
            host.mount_unit('/source/cache', '/var/cache/intar-agent', 'bind')
        text = (unit_root / 'test.mount').read_text()
        self.assertIn('RequiresMountsFor=/source/cache', text)
        self.assertIn('Before=intar-jailerd.socket intar-jailerd.service intar-personal-check.service intar-agent.service', text)

    def test_discard_disabled_only_for_owned_loop_and_doctor_is_read_only(self):
        limit = self.root / 'sys/loop7/queue/discard_max_bytes'
        limit.parent.mkdir(parents=True)
        limit.write_text('4096\n')
        host.IMAGE.write_bytes(b'owned')
        def path(value):
            return self.root / 'sys' if value == '/sys/block' else Path(value)
        with patch.object(host, 'Path', side_effect=path), patch.object(host, 'run', side_effect=['/dev/loop7', str(host.IMAGE)]):
            host.disable_loop_discard()
        self.assertEqual(limit.read_text(), '0\n')
        limit.write_text('4096\n')
        with patch.object(host, 'Path', side_effect=path), patch.object(host, 'run', side_effect=['/dev/loop7', str(host.IMAGE)]):
            with self.assertRaises(host.HostError):
                host.disable_loop_discard(read_only=True)
        self.assertEqual(limit.read_text(), '4096\n')
        with patch.object(host, 'run', return_value='/dev/sda'):
            with self.assertRaises(host.HostError):
                host.disable_loop_discard()

    def test_boot_service_runs_privileged_proof_before_doctor(self):
        events = []
        host.save({'storage': {'kind': 'directory'}})
        with patch.object(host.sys, 'argv', ['intar-host', 'verify-boot']), patch.object(host.os, 'geteuid', return_value=0), patch.object(host.resource, 'setrlimit'), patch.object(host, 'no_vms', side_effect=lambda: events.append('empty')), patch.object(host, 'run', side_effect=lambda *a, **k: events.append(a)), patch.object(host, 'doctor', side_effect=lambda: events.append('doctor')):
            host.main()
        self.assertEqual(events, ['empty', ('/usr/lib/intar/intar-jailerd-self-test',), 'doctor'])

    def test_failed_boot_proof_never_runs_doctor(self):
        host.save({'storage': {'kind': 'directory'}})
        with patch.object(host.sys, 'argv', ['intar-host', 'verify-boot']), patch.object(host.os, 'geteuid', return_value=0), patch.object(host.resource, 'setrlimit'), patch.object(host, 'no_vms'), patch.object(host, 'run', side_effect=host.HostError('proof failed')), patch.object(host, 'doctor') as doctor:
            with self.assertRaises(host.HostError):
                host.main()
            doctor.assert_not_called()

    def test_uninstall_already_removed_preserves_files(self):
        host.CREDENTIAL.write_text('keep')
        with patch.object(host, 'run') as run, contextlib.redirect_stdout(io.StringIO()):
            host.uninstall({'phase': 'removed'}, 1)
        self.assertEqual(host.CREDENTIAL.read_text(), 'keep')
        run.assert_not_called()

    def test_ready_waits_for_control_and_tunnel(self):
        reports = [
            {'draining': False, 'ready': False, 'connected': True, 'relayConnected': False},
            {'draining': False, 'ready': True, 'connected': True, 'relayConnected': True},
        ]
        with patch.object(host, 'agent', side_effect=[json.dumps(r) for r in reports]) as agent, patch.object(host, 'active', return_value=True), patch.object(host.time, 'sleep') as sleep:
            host.wait_ready()
        self.assertEqual(agent.call_count, 2)
        sleep.assert_called_once()

    def test_missing_readiness_does_not_report_ready(self):
        with patch.object(host, 'agent', return_value='{"draining":false,"trackedVms":0}'), patch.object(host, 'active', return_value=True), patch.object(host.time, 'monotonic', side_effect=[0, 121]):
            with self.assertRaisesRegex(host.HostError, 'not ready'):
                host.wait_ready()

    def test_remove_data_refuses_active_vms_before_deletion(self):
        host.CREDENTIAL.write_text('preserve')
        with patch.object(host, 'no_vms', side_effect=host.HostError('VM active')), patch.object(host.shutil, 'rmtree') as delete:
            with self.assertRaises(host.HostError):
                host.remove_data({'storage': {'kind': 'directory'}})
        self.assertEqual(host.CREDENTIAL.read_text(), 'preserve')
        delete.assert_not_called()

    def test_remove_data_refuses_an_unowned_mount(self):
        target = self.root / 'target'
        target.mkdir()
        with patch.object(host, 'MOUNTS', {'cache': target}), patch.object(host, 'no_vms'), patch.object(host, 'is_mounted', side_effect=lambda p: p == target), patch.object(host.os.path, 'samefile', return_value=False), patch.object(host.shutil, 'rmtree') as delete:
            with self.assertRaises(host.HostError):
                host.remove_data({'storage': {'kind': 'directory'}})
        delete.assert_not_called()

    def test_remove_data_refuses_changed_storage_file(self):
        host.IMAGE.write_text('preserve')
        with patch.object(host, 'no_vms'), patch.object(host.shutil, 'rmtree') as delete:
            with self.assertRaises(host.HostError):
                host.remove_data({'storage': {'kind': 'loop', 'device': -1, 'inode': -1}})
        self.assertEqual(host.IMAGE.read_text(), 'preserve')
        delete.assert_not_called()

    def test_remove_data_refuses_extra_nested_mounts(self):
        for target in (host.ROOT, host.ROOT / 'releases/other-data'):
            mounts = {'filesystems': [{'target': '/'}, {'target': str(target)}]}
            with patch.object(host, 'no_vms'), patch.object(host, 'is_mounted', return_value=False), patch.object(host, 'run', return_value=json.dumps(mounts)), patch.object(host.shutil, 'rmtree') as delete:
                with self.assertRaises(host.HostError):
                    host.remove_data({'storage': {'kind': 'directory'}})
            delete.assert_not_called()

    def test_explicit_removal_deletes_only_owned_data(self):
        managed = self.root / 'managed'
        managed.mkdir()
        (managed / 'state.json').write_text('{}')
        (managed / 'cache-data').write_text('owned')
        outside = self.root / 'outside'
        outside.write_text('preserve')
        (managed / 'symlink').symlink_to(outside)
        command = self.root / 'manager'
        command.write_text('owned')
        config = self.root / 'config'
        config.mkdir()
        (config / 'operator.txt').write_text('preserve')
        (config / 'config.toml').write_text('owned')
        (config / 'credential.json').write_text('owned')
        with patch.object(host, 'ROOT', managed), patch.object(host, 'STATE', managed / 'state.json'), patch.object(host, 'STORAGE', managed / 'storage'), patch.object(host, 'MOUNTS', {}), patch.object(host, 'COMMAND', command), patch.object(host, 'CONFIG', config / 'config.toml'), patch.object(host, 'CREDENTIAL', config / 'credential.json'), patch.object(host, 'no_vms'), patch.object(host, 'is_mounted', return_value=False), patch.object(host, 'run', return_value='{"filesystems":[]}'), contextlib.redirect_stdout(io.StringIO()):
            host.remove_data({'storage': {'kind': 'directory'}})
        self.assertFalse(managed.exists())
        self.assertFalse(command.exists())
        self.assertFalse((config / 'credential.json').exists())
        self.assertEqual(outside.read_text(), 'preserve')
        self.assertEqual((config / 'operator.txt').read_text(), 'preserve')

    def test_uninstall_purge_is_opt_in(self):
        with patch.object(host, 'remove_data') as remove, contextlib.redirect_stdout(io.StringIO()):
            host.uninstall({'phase': 'removed'}, 1)
            remove.assert_not_called()
            host.uninstall({'phase': 'removed'}, 1, purge=True)
            remove.assert_called_once()

    def test_uninstall_recovers_an_incomplete_first_install_and_keeps_data(self):
        state = {'phase': 'installing', 'pendingVersion': '1.2.3'}
        host.CREDENTIAL.write_text('preserve')
        with patch.object(host, 'drain') as drain, patch.object(host, 'remove_runtime') as remove, contextlib.redirect_stdout(io.StringIO()):
            host.uninstall(state, 15)
        drain.assert_called_once_with(state, 15)
        remove.assert_called_once()
        self.assertEqual(host.load(host.STATE)['phase'], 'removed')
        self.assertEqual(host.CREDENTIAL.read_text(), 'preserve')

    def test_failed_setup_proof_keeps_maintenance_and_never_starts_agent(self):
        package = self.root / 'package'
        host.JAILER_CONFIG.parent.mkdir()
        (package / 'deploy/personal-metal').mkdir(parents=True)
        (package / 'deploy/personal-metal/intar-host').write_text('manager')
        calls = []
        def run(*args, **kwargs):
            calls.append(args)
            if args == ('systemctl', 'start', 'intar-personal-check.service'):
                raise host.HostError('self-test failed')
        with contextlib.ExitStack() as mocks:
            for name in ('preflight', 'no_vms', 'install_dependencies', 'storage', 'configure', 'boot_units'):
                mocks.enter_context(patch.object(host, name))
            mocks.enter_context(patch.object(host, 'active', return_value=False))
            mocks.enter_context(patch.object(host, 'package_for', return_value=(package, '1.2.3')))
            mocks.enter_context(patch.object(host, 'ensure_user', return_value=types.SimpleNamespace(pw_gid=42)))
            mocks.enter_context(patch.object(host, 'digest', return_value='same'))
            mocks.enter_context(patch.object(host, 'run', side_effect=run))
            with self.assertRaises(host.HostError):
                host.setup({}, types.SimpleNamespace(command='setup', version=None, drain_timeout=1))
        self.assertTrue(host.MAINTENANCE.exists())
        self.assertEqual(host.load(host.STATE)['phase'], 'checking')
        self.assertNotIn(('systemctl', 'enable', '--now', 'intar-agent.service'), calls)

    def test_public_retry_keeps_pending_version(self):
        state = {'pendingVersion': '1.2.3'}
        with patch.object(host, 'download', side_effect=host.HostError('offline')):
            with self.assertRaises(host.HostError):
                host.package_for(state, '9.9.9')
        self.assertEqual(host.load(host.STATE)['pendingVersion'], '1.2.3')

    def test_explicit_update_replaces_failed_download_without_changing_drain_or_data(self):
        state = {'phase': 'draining', 'version': '1.2.3', 'pendingVersion': '99.0.0',
                 'storage': {'kind': 'directory'}}
        host.MAINTENANCE.write_text('keep drained')
        host.ENROLLMENT.write_text('keep credential')
        urls = []
        def download(url, destination):
            urls.append(url)
            raise host.HostError('offline')
        with patch.object(host, 'download', side_effect=download), patch.object(host, 'agent') as agent:
            with self.assertRaises(host.HostError):
                host.package_for(state, '1.2.4', replace_pending=True)
        self.assertIn('agent%2Fv1.2.4/', urls[0])
        self.assertEqual(host.load(host.STATE), {**state, 'pendingVersion': '1.2.4'})
        self.assertEqual(state['phase'], 'draining')
        self.assertEqual(state['version'], '1.2.3')
        self.assertEqual(host.MAINTENANCE.read_text(), 'keep drained')
        self.assertEqual(host.ENROLLMENT.read_text(), 'keep credential')
        agent.assert_not_called()

    def test_cancel_failed_download_only_clears_the_release_selection(self):
        state = {'phase': 'draining', 'version': '1.2.3', 'pendingVersion': '99.0.0',
                 'storage': {'kind': 'loop', 'inode': 123, 'device': 1}}
        host.MAINTENANCE.write_text('keep drained')
        host.ENROLLMENT.write_text('keep credential')
        expected = dict(state)
        del expected['pendingVersion']
        with patch.object(host, 'run') as run, contextlib.redirect_stdout(io.StringIO()):
            host.cancel_update(state)
        self.assertEqual(host.load(host.STATE), expected)
        self.assertEqual(host.MAINTENANCE.read_text(), 'keep drained')
        self.assertEqual(host.ENROLLMENT.read_text(), 'keep credential')
        run.assert_not_called()

    def test_applied_release_cannot_be_canceled_or_replaced(self):
        state = {'phase': 'installing', 'pendingVersion': '1.2.4', 'pendingStarted': True}
        host.save(state)
        for action in (lambda: host.cancel_update(state),
                       lambda: host.package_for(state, '1.2.5', replace_pending=True)):
            with self.assertRaises(host.HostError):
                action()
            self.assertEqual(host.load(host.STATE), state)

    def test_unavailable_dependency_can_be_replaced_without_resuming_work(self):
        package = self.root / 'package'
        (package / 'deploy/personal-metal').mkdir(parents=True)
        (package / 'deploy/personal-metal/intar-host').write_text('manager')
        state = {'pendingVersion': '1.2.4'}
        with contextlib.ExitStack() as mocks:
            for name in ('preflight', 'no_vms'):
                mocks.enter_context(patch.object(host, name))
            mocks.enter_context(patch.object(host, 'active', return_value=False))
            mocks.enter_context(patch.object(host, 'package_for', return_value=(package, '1.2.4')))
            mocks.enter_context(patch.object(host, 'digest', return_value='same'))
            mocks.enter_context(patch.object(host, 'install_dependencies', side_effect=host.HostError('pin unavailable')))
            with self.assertRaises(host.HostError):
                host.setup(state, types.SimpleNamespace(command='setup', version=None, drain_timeout=1))
        self.assertEqual(state['phase'], 'dependencies')
        self.assertNotIn('pendingStarted', state)
        with contextlib.redirect_stdout(io.StringIO()):
            host.cancel_update(state)
        self.assertTrue(host.MAINTENANCE.exists())
        self.assertNotIn('pendingVersion', host.load(host.STATE))

    def test_invalid_replacement_does_not_change_pending_release(self):
        state = {'pendingVersion': '1.2.3'}
        host.save(state)
        with self.assertRaises(host.HostError):
            host.package_for(state, '../bad', replace_pending=True)
        self.assertEqual(host.load(host.STATE), {'pendingVersion': '1.2.3'})

    def test_mount_table_detects_same_filesystem_bind_and_requires_exact_path(self):
        table = {'filesystems': [{'target': '/'}, {'target': '/var/cache/intar-agent'}]}
        with patch.object(host, 'run', return_value=json.dumps(table)), patch.object(host.os.path, 'ismount', return_value=False):
            self.assertTrue(host.is_mounted('/var/cache/intar-agent'))
            self.assertFalse(host.is_mounted('/var/cache/intar-agent/state'))
        with patch.object(host, 'run', side_effect=host.HostError('findmnt failed')):
            with self.assertRaises(host.HostError):
                host.is_mounted('/var/cache/intar-agent')

    def test_mount_unit_verifies_same_filesystem_bind_source_after_start(self):
        unit_root = self.root / 'units'
        unit_root.mkdir()
        table = {'filesystems': [{'target': '/var/cache/intar-agent'}]}
        with patch.object(host, 'UNITS', unit_root), patch.object(host, 'mount_name', return_value='test.mount'), patch.object(host, 'run', return_value=json.dumps(table)), patch.object(host.os.path, 'ismount', return_value=False), patch.object(host.os.path, 'samefile', return_value=True) as samefile:
            host.mount_unit('/source/cache', '/var/cache/intar-agent', 'bind')
        samefile.assert_called_once_with('/source/cache', '/var/cache/intar-agent')
        with patch.object(host, 'UNITS', unit_root), patch.object(host, 'mount_name', return_value='test.mount'), patch.object(host, 'run', return_value=json.dumps(table)), patch.object(host.os.path, 'samefile', return_value=False):
            with self.assertRaises(host.HostError):
                host.mount_unit('/source/cache', '/var/cache/intar-agent', 'bind')

    def test_doctor_accepts_same_filesystem_bind_mounts_and_refuses_missing_mount(self):
        state = {'version': '1.2.3', 'storage': {'kind': 'directory'}}
        table = {'filesystems': [{'target': str(p)} for p in host.MOUNTS.values()]}
        with contextlib.ExitStack() as mocks:
            mocks.enter_context(patch.object(host, 'preflight'))
            mocks.enter_context(patch.object(host, 'load', return_value=state))
            mocks.enter_context(patch.object(host, 'verify_package'))
            mocks.enter_context(patch.object(host, 'digest', return_value='same'))
            mocks.enter_context(patch.object(host, 'secure_path'))
            mocks.enter_context(patch.object(host.os.path, 'ismount', return_value=False))
            mocks.enter_context(patch.object(host.os.path, 'samefile', return_value=True))
            mocks.enter_context(patch.object(host.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=20 * host.GIB)))
            agent = mocks.enter_context(patch.object(host, 'agent', return_value='doctor passed'))
            with patch.object(host, 'run', return_value=json.dumps(table)), contextlib.redirect_stdout(io.StringIO()):
                host.doctor()
            agent.assert_called_once_with('--doctor')
            with patch.object(host, 'run', return_value='{"filesystems":[]}'):
                with self.assertRaises(host.HostError):
                    host.doctor()

    def test_purge_after_insufficient_space_handles_a_never_created_loop_file(self):
        state = {'phase': 'storage'}
        with patch.object(host, 'reflink', return_value=False), patch.object(host.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=109 * host.GIB)):
            with self.assertRaises(host.HostError):
                host.storage(state)
        self.assertEqual(state['storage'], {'kind': 'loop'})
        self.assertFalse(host.IMAGE.exists())
        with tempfile.TemporaryDirectory() as outside:
            command = Path(outside) / 'intar-host'
            command.write_text('manager')
            unrelated = Path(outside) / 'unrelated'
            unrelated.write_text('keep')
            with patch.object(host, 'COMMAND', command), patch.object(host, 'MOUNTS', {}), patch.object(host, 'UNITS', self.root / 'units'), patch.object(host, 'mount_name', return_value='storage.mount'), patch.object(host, 'drain'), patch.object(host, 'remove_runtime'), patch.object(host, 'no_vms'), patch.object(host, 'run', return_value='{"filesystems":[]}'), contextlib.redirect_stdout(io.StringIO()):
                host.uninstall(state, 1, purge=True)
            self.assertFalse(host.ROOT.exists())
            self.assertFalse(command.exists())
            self.assertEqual(unrelated.read_text(), 'keep')

    def test_purge_refuses_existing_unrecorded_file_and_mount_without_file(self):
        for spec in ({'kind': 'loop'}, {'kind': 'loop', 'creating': True}):
            host.IMAGE.write_text('unowned data')
            with patch.object(host, 'no_vms'), patch.object(host.shutil, 'rmtree') as delete:
                with self.assertRaises(host.HostError):
                    host.remove_data({'storage': spec})
                delete.assert_not_called()
            self.assertEqual(host.IMAGE.read_text(), 'unowned data')
        host.IMAGE.unlink()
        with patch.object(host, 'no_vms'), patch.object(host, 'mounted_paths', return_value={host.STORAGE}), patch.object(host.shutil, 'rmtree') as delete:
            with self.assertRaises(host.HostError):
                host.remove_data({'storage': {'kind': 'loop'}})
            delete.assert_not_called()

    def test_published_launcher_and_package_assets_are_connected(self):
        workflow = (REPO / '.github/workflows/release.yml').read_text()
        self.assertIn('sh deploy/personal-metal/package.sh', workflow)
        self.assertIn('intar-agent_${VERSION}_intar-host', workflow)
        self.assertLess(workflow.index('Run privileged agent package smoke'), workflow.index('Preserve exact release payload'))
        launcher = (REPO / 'apps/web/public/install.sh').read_text()
        self.assertIn('intar-agent_{version}_intar-host', launcher)
        self.assertNotIn('enrollmentToken', launcher)
        self.assertNotIn('bootstrap_token', SOURCE.read_text())


class PathTrustTests(unittest.TestCase):
    def test_rejects_group_writable_symlink_and_hardlink_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            secret = base / 'secret'
            secret.write_text('data')
            original_lstat = Path.lstat
            def trusted_parents(path):
                info = original_lstat(path)
                if path != secret:
                    fields = list(info)
                    fields[4] = 0
                    fields[0] = stat.S_IFDIR | 0o755
                    return os.stat_result(fields)
                return info
            with patch.object(Path, 'lstat', trusted_parents):
                secret.chmod(0o660)
                with self.assertRaises(host.HostError):
                    host.secure_path(secret, uid=os.getuid())
                secret.chmod(0o600)
                os.link(secret, base / 'hard')
                with self.assertRaises(host.HostError):
                    host.secure_path(secret, uid=os.getuid())
                secret.unlink()
                secret.symlink_to(base / 'hard')
                with self.assertRaises(host.HostError):
                    host.secure_path(secret, uid=os.getuid())


if __name__ == '__main__':
    unittest.main()

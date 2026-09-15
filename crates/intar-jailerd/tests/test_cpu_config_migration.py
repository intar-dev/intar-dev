import importlib.util
import sys
import unittest
from pathlib import Path

if sys.version_info < (3, 11):
    raise unittest.SkipTest("host configuration migration requires Python 3.11")

spec = importlib.util.spec_from_file_location(
    "cpu_config", Path(__file__).parents[1] / "deploy/migrate-cpu-config.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CpuConfigurationMigration(unittest.TestCase):
    def test_agent_keeps_other_settings_and_comments(self):
        source = '# before\n[vm_defaults.resources]\nvcpus = 2 # guest\nmemory_mib = 512\n[other]\nvcpus = 9\n'
        result = module.migrate(source, "agent")
        self.assertEqual(result, source.replace('vcpus = 2 # guest', 'cpu_millis = 2000 # guest'))
        self.assertEqual(module.migrate(result, "agent"), result)

    def test_jailerd_keeps_host_reserve_and_unrelated_values(self):
        source = 'cpu_reserved_millis = 1000\nboot_cpu_millis = 2000\nboot_cpu_lease_ms = 45000\n[other]\nboot_cpu_millis = 9\n'
        self.assertEqual(module.migrate(source, "jailerd"), 'cpu_reserved_millis = 1000\n[other]\nboot_cpu_millis = 9\n')

    def test_conflicting_or_invalid_legacy_limits_fail_before_write(self):
        for resources in ['vcpus = 2\ncpu_millis = 500', 'vcpus = 0', 'vcpus = true']:
            with self.assertRaises(ValueError):
                module.migrate('[vm_defaults.resources]\n' + resources, "agent")


if __name__ == "__main__":
    unittest.main()

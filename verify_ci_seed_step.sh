# Verify the CI seed step exactly as it will run in the pipeline, using the
# container's own psql (this machine has no psql client installed).
#
# IMPORTANT: the roles are CLUSTER-WIDE, so 00_roles.sql against a throwaway
# database still resets the SHARED role passwords. In CI the cluster is
# disposable, so the step is safe there; on a shared machine it is not. This
# script therefore passes the LOCAL passwords, which makes the cluster-wide
# ALTER ROLE a no-op, and the grants land on the throwaway database.
set -euo pipefail

DB=nexus_ci_seed_check
C=nexus-platform-postgres

echo "--- drop and recreate the throwaway database"
docker exec "$C" psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS ${DB};" -q 2>/dev/null || true
docker exec "$C" psql -U postgres -d postgres -c "CREATE DATABASE ${DB};" -q

echo "--- apply the schema"
for f in $(ls infra/db/migrations/*.sql | sort -V); do
  docker exec -i "$C" psql -U postgres -d "${DB}" -v ON_ERROR_STOP=1 -q < "$f" 2>&1 | grep -v NOTICE || true
done

echo "--- the role grants, with the LOCAL passwords so the cluster-wide ALTER ROLE is a no-op"
docker exec -i -e NEXUS_DB_APP_PASSWORD=nexus_dev_app_only -e NEXUS_DB_AI_PASSWORD=nexus_dev_ai_only \
  "$C" psql -U postgres -d "${DB}" -v ON_ERROR_STOP=1 -q \
  < infra/postgres/init/00_roles.sql 2>&1 | grep -v NOTICE || true

echo "--- generate the seed"
python data/seed/generate.py --counts ci | tail -3

echo "--- load the seed (--single-transaction, as load.sh does)"
for f in $(ls data/seed/out/*.sql | sort -V); do
  docker exec -i "$C" psql -U postgres -d "${DB}" \
    -v ON_ERROR_STOP=1 --single-transaction -q < "$f" 2>&1 | grep -v NOTICE || true
done

echo "--- the published-merchant count the CI step asserts"
count=$(docker exec "$C" psql -U postgres -d "${DB}" -tAc \
  "select count(*) from merchants where status = 'published'")
echo "published merchants: ${count}"
if ! echo "${count}" | grep -qE '^[1-9][0-9]*$'; then
  echo "FAIL: the seed published no merchant"
  exit 1
fi
echo "PASS: the seed is loadable and the guard holds"

echo "--- the live suite against THIS database (as CI would run it)"
cd apps/ai
NEXUS_TEST_DATABASE_URL="postgresql://nexus_ai:nexus_dev_ai_only@127.0.0.1:5433/${DB}" \
  ./.venv/Scripts/python.exe -m pytest tests/test_live_preferences.py -q 2>&1 | tail -4
cd ../..

echo "--- drop the throwaway database"
docker exec "$C" psql -U postgres -d postgres -c "DROP DATABASE ${DB};" -q
echo "DONE"
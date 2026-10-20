# Verify the CI seed step exactly as it will run in the pipeline, using the
# container's own psql (this machine has no psql client installed).
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

echo "--- grant the AI role, as the CI step before this one does"
docker exec -i -e NEXUS_DB_APP_PASSWORD=ci_nexus_app -e NEXUS_DB_AI_PASSWORD=ci_nexus_ai \
  "$C" psql -U postgres -d "${DB}" -v ON_ERROR_STOP=1 -q \
  < infra/postgres/init/00_roles.sql 2>&1 | grep -v NOTICE || true
docker exec "$C" psql -U postgres -d "${DB}" -q -c "alter role nexus_ai with password 'ci_nexus_ai';" 2>&1 | grep -v NOTICE || true

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
NEXUS_TEST_DATABASE_URL="postgresql://nexus_ai:ci_nexus_ai@127.0.0.1:5433/${DB}" \
  ./.venv/Scripts/python.exe -m pytest tests/test_live_preferences.py -q 2>&1 | tail -5
cd ../..

echo "--- drop the throwaway database"
docker exec "$C" psql -U postgres -d postgres -c "DROP DATABASE ${DB};" -q
echo "DONE"
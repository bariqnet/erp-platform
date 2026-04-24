# VPC + subnets + NAT + gateways.
#
# Layout:
#
#   10.40.0.0/16  VPC
#     10.40.0.0/24    public  AZ-a    (ALB + NAT)
#     10.40.1.0/24    public  AZ-b    (ALB + NAT)
#     10.40.2.0/24    public  AZ-c    (ALB + NAT)
#     10.40.16.0/22   private AZ-a    (ECS + RDS + Redis)
#     10.40.20.0/22   private AZ-b    (ECS + RDS + Redis)
#     10.40.24.0/22   private AZ-c    (ECS + RDS + Redis)
#
# Public subnets get one NAT each so private→internet egress
# tolerates a single AZ failure. Staging can downgrade to one NAT
# to save ~$90/month by setting `single_nat_gateway = true`.

# ── VPC ──────────────────────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${local.name_prefix}-vpc"
  }
}

# ── Internet gateway ────────────────────────────────────────────

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-igw"
  }
}

# ── Subnets ─────────────────────────────────────────────────────

resource "aws_subnet" "public" {
  count                   = local.az_count
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                     = "${local.name_prefix}-public-${var.availability_zones[count.index]}"
    Tier                     = "public"
    "kubernetes.io/role/elb" = "1" # Harmless for ECS; useful if the EKS epic lands later.
  }
}

resource "aws_subnet" "private" {
  count             = local.az_count
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name                              = "${local.name_prefix}-private-${var.availability_zones[count.index]}"
    Tier                              = "private"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

# ── NAT (one per AZ) ────────────────────────────────────────────
# Production-posture: one NAT per AZ. A zonal outage still lets the
# other two AZs' tasks pull image layers + reach the internet.

resource "aws_eip" "nat" {
  count  = local.az_count
  domain = "vpc"

  tags = {
    Name = "${local.name_prefix}-nat-${var.availability_zones[count.index]}"
  }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_nat_gateway" "main" {
  count         = local.az_count
  subnet_id     = aws_subnet.public[count.index].id
  allocation_id = aws_eip.nat[count.index].id

  tags = {
    Name = "${local.name_prefix}-nat-${var.availability_zones[count.index]}"
  }

  depends_on = [aws_internet_gateway.main]
}

# ── Route tables ────────────────────────────────────────────────
# Public: default route through the IGW.

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name_prefix}-public"
  }
}

resource "aws_route_table_association" "public" {
  count          = local.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private: one route table per AZ, default route through the NAT
# in the same AZ. Cross-AZ NAT traffic is expensive AND unnecessary.

resource "aws_route_table" "private" {
  count  = local.az_count
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = {
    Name = "${local.name_prefix}-private-${var.availability_zones[count.index]}"
  }
}

resource "aws_route_table_association" "private" {
  count          = local.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# ── VPC endpoints (cost + privacy) ──────────────────────────────
# S3 gateway endpoint — free, keeps S3 traffic off the NAT.
# ECR interface endpoints — paid, but ECS task image-pull traffic
# is the dominant NAT cost; endpoints pay for themselves at
# ~1000 task starts/day.

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = {
    Name = "${local.name_prefix}-s3-endpoint"
  }
}
